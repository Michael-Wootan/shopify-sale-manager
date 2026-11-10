#!/usr/bin/env node
/**
 * Shopify Sale Manager
 * Runs a two-phase site-wide sale: schedules back-to-back automatic discounts
 * and marks compare-at price strikethroughs across the catalog, through the
 * Shopify Admin API (GraphQL + REST). Every price change is backed up first.
 *
 * The sale is defined in config/sale.json:
 *   phase1: { title, percent, startsAt }
 *   phase2: { title, percent, startsAt, endsAt }
 * Phase 1 ends one second before phase 2 starts.
 *
 * Setup:
 *   SHOPIFY_STORE=your-store.myshopify.com
 *   SHOPIFY_ADMIN_TOKEN=your_admin_api_token
 *   Requires Node 18+ (uses native fetch)
 *
 *   Token scopes needed:
 *     write_discounts, read_discounts
 *     write_products,  read_products   (for price-mark / price-restore)
 *
 * Commands:
 *   node src/sale-manager.js status             show active discounts
 *   node src/sale-manager.js set-phase1         schedule phase 1 and pre-schedule phase 2
 *   node src/sale-manager.js set-phase2         schedule or activate phase 2
 *   node src/sale-manager.js price-mark         strikethrough prices at the phase 1 percentage
 *   node src/sale-manager.js price-mark-phase2  move marked prices to the phase 2 percentage
 *   node src/sale-manager.js price-restore      restore original prices after the sale
 *   node src/sale-manager.js end                deactivate the sale discounts
 */

import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// ─── Load .env ────────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const _envPath  = resolve(__dirname, '..', '.env');
if (existsSync(_envPath)) {
  readFileSync(_envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([^#=\s][^=]*)=(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  });
}

// ─── Config ───────────────────────────────────────────────────────────────────
const SHOP  = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

// ─── Sale definition (config/sale.json, falls back to the committed example) ──
const CONFIG_DIR = process.env.CONFIG_DIR || resolve(__dirname, '..', 'config');
function loadSale() {
  for (const f of ['sale.json', 'sale.example.json']) {
    const p = resolve(CONFIG_DIR, f);
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  }
  throw new Error('Missing config/sale.json');
}
const SALE = loadSale();
const P1 = { ...SALE.phase1, rate: SALE.phase1.percent / 100 };
const P2 = { ...SALE.phase2, rate: SALE.phase2.percent / 100 };

const SALE_START   = new Date(P1.startsAt);
const PHASE2_START = new Date(P2.startsAt);
const SALE_END     = new Date(P2.endsAt);
const when = d => d.toUTCString();

const SALE_TITLES = [P1.title, P2.title];
const BACKUP_DIR  = process.env.BACKUP_DIR || resolve(__dirname, '..', 'backups');
if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
const BACKUP_FILE = resolve(BACKUP_DIR, 'price-backup.json');

// Rate limit: Shopify REST allows ~2 req/s on standard plans
const RATE_DELAY_MS = 550;

// ─── Guard ────────────────────────────────────────────────────────────────────
if (!SHOP || !TOKEN) {
  console.error(`
❌  Missing environment variables.

  SHOPIFY_STORE=your-store.myshopify.com
  SHOPIFY_ADMIN_TOKEN=your_admin_api_token

To get a token: Shopify Admin → Settings → Apps → Develop apps → Create app
Required scopes: write_discounts, read_discounts, write_products, read_products
`);
  process.exit(1);
}

// ─── API helpers ──────────────────────────────────────────────────────────────
const GQL_API   = `https://${SHOP}/admin/api/2024-04/graphql.json`;
const REST_BASE = `https://${SHOP}/admin/api/2024-04`;
const HEADERS   = { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN };

async function gql(query, variables = {}) {
  const res = await fetch(GQL_API, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GQL HTTP ${res.status}: ${await res.text()}`);
  const { data, errors } = await res.json();
  if (errors?.length) throw new Error(JSON.stringify(errors, null, 2));
  return data;
}

async function rest(method, path, body) {
  const res = await fetch(`${REST_BASE}${path}`, {
    method,
    headers: HEADERS,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`REST ${method} ${path} → ${res.status}: ${txt}`);
  }
  return res.json();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(msg)  { console.log(`  ${msg}`); }
function ok(msg)   { console.log(`✅  ${msg}`); }
function warn(msg) { console.log(`⚠️  ${msg}`); }
function die(msg)  { console.error(`❌  ${msg}`); process.exit(1); }

// ─── GraphQL fragments ────────────────────────────────────────────────────────

const LIST_DISCOUNTS = `
  query {
    automaticDiscountNodes(first: 25) {
      edges {
        node {
          id
          automaticDiscount {
            ... on DiscountAutomaticBasic {
              title status startsAt endsAt
              customerGets {
                value { ... on DiscountPercentage { percentage } }
              }
            }
          }
        }
      }
    }
  }
`;

const CREATE_DISCOUNT = `
  mutation CreateDiscount($input: DiscountAutomaticBasicInput!) {
    discountAutomaticBasicCreate(automaticBasicDiscount: $input) {
      automaticDiscountNode {
        id
        automaticDiscount {
          ... on DiscountAutomaticBasic { title status startsAt endsAt }
        }
      }
      userErrors { field message }
    }
  }
`;

const UPDATE_DISCOUNT = `
  mutation UpdateDiscount($id: ID!, $input: DiscountAutomaticBasicInput!) {
    discountAutomaticBasicUpdate(id: $id, automaticBasicDiscount: $input) {
      automaticDiscountNode {
        id
        automaticDiscount {
          ... on DiscountAutomaticBasic { title status startsAt endsAt }
        }
      }
      userErrors { field message }
    }
  }
`;

const DEACTIVATE_DISCOUNT = `
  mutation DeactivateDiscount($id: ID!) {
    discountAutomaticDeactivate(id: $id) {
      automaticDiscountNode {
        id
        automaticDiscount { ... on DiscountAutomaticBasic { title status } }
      }
      userErrors { field message }
    }
  }
`;

// ─── Discount helpers ─────────────────────────────────────────────────────────

async function getSaleDiscounts() {
  const data = await gql(LIST_DISCOUNTS);
  return data.automaticDiscountNodes.edges
    .map(e => ({ id: e.node.id, ...e.node.automaticDiscount }))
    .filter(d => SALE_TITLES.includes(d.title));
}

async function getAllDiscounts() {
  const data = await gql(LIST_DISCOUNTS);
  return data.automaticDiscountNodes.edges.map(e => ({
    id: e.node.id, ...e.node.automaticDiscount,
  }));
}

function makeDiscountInput(title, pct, startsAt, endsAt) {
  return {
    title,
    startsAt,
    ...(endsAt ? { endsAt } : {}),
    customerGets: {
      value: { percentage: pct },
      items: { all: true },
    },
    // No minimum order requirement: applies to all orders
    combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: true },
  };
}

async function upsertDiscount(title, pct, startsAt, endsAt, existing) {
  const input = makeDiscountInput(title, pct, startsAt, endsAt);
  if (existing) {
    const data = await gql(UPDATE_DISCOUNT, { id: existing.id, input });
    const errs = data.discountAutomaticBasicUpdate?.userErrors;
    if (errs?.length) die(JSON.stringify(errs));
    return data.discountAutomaticBasicUpdate?.automaticDiscountNode;
  } else {
    const data = await gql(CREATE_DISCOUNT, { input });
    const errs = data.discountAutomaticBasicCreate?.userErrors;
    if (errs?.length) die(JSON.stringify(errs));
    return data.discountAutomaticBasicCreate?.automaticDiscountNode;
  }
}

// ─── Product helpers ──────────────────────────────────────────────────────────

async function fetchAllProducts() {
  const products = [];
  let url = `${REST_BASE}/products.json?limit=250&fields=id,title,variants&status=active`;

  while (url) {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`Products fetch failed: ${res.status}`);
    const linkHeader = res.headers.get("link") || "";
    const body = await res.json();
    products.push(...body.products);
    const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    url = nextMatch ? nextMatch[1] : null;
    if (url) await sleep(RATE_DELAY_MS);
  }
  return products;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function cmdStatus() {
  console.log("\n📊  Current automatic discounts on", SHOP, "\n");
  const discounts = await getAllDiscounts();

  if (!discounts.length) {
    log("No automatic discounts found.");
  } else {
    for (const d of discounts) {
      const pct   = d.customerGets?.value?.percentage
        ? `${(d.customerGets.value.percentage * 100).toFixed(0)}% off`
        : "unknown value";
      const start = d.startsAt ? new Date(d.startsAt).toLocaleString() : "-";
      const end   = d.endsAt   ? new Date(d.endsAt).toLocaleString()   : "no end date";
      const mine  = SALE_TITLES.includes(d.title) ? " 👈" : "";
      log(`${d.status === "ACTIVE" ? "🟢" : "⚪"} ${d.title}${mine}`);
      log(`   Value:  ${pct}`);
      log(`   From:   ${start}`);
      log(`   Until:  ${end}`);
      log(`   ID:     ${d.id}`);
      log("");
    }
  }

  log(`Price backup: ${existsSync(BACKUP_FILE) ? "✅ exists (price-mark has been run)" : "❌ not found (price-mark not yet run)"}`);
  console.log();
}

async function cmdSetPhase1() {
  console.log(`\n🏷️  Scheduling ${P1.percent}% site-wide sale...\n`);

  const existing = await getSaleDiscounts();
  const phase1Disc   = existing.find(d => d.title === P1.title);
  const phase2Disc   = existing.find(d => d.title === P2.title);

  // Phase 1 runs from its start until one second before phase 2
  const startsAt  = SALE_START.toISOString();
  const endsPhase1At  = new Date(PHASE2_START.getTime() - 1000).toISOString(); // 1s before phase 2
  // Phase 2 runs from its start to the sale end
  const startsPhase2  = PHASE2_START.toISOString();
  const endsPhase2At  = SALE_END.toISOString();

  const result = await upsertDiscount(P1.title, P1.rate, startsAt, endsPhase1At, phase1Disc);
  ok(`${P1.percent}% site-wide sale scheduled`);
  log(`Starts:   ${when(SALE_START)}`);
  log(`Expires:  ${when(PHASE2_START)}  (hands off to ${P2.percent}%)`);
  log(`ID:       ${result?.id}`);

  log("");
  if (!phase2Disc) {
    log(`Pre-scheduling phase 2 (${P2.percent}%)...`);
    const r2 = await upsertDiscount(P2.title, P2.rate, startsPhase2, endsPhase2At, null);
    ok(`Phase 2 (${P2.percent}%) scheduled: fires and expires automatically`);
    log(`Starts:   ${when(PHASE2_START)}`);
    log(`Expires:  ${when(SALE_END)}`);
    log(`ID:       ${r2?.id}`);
  } else {
    log("Phase 2 discount already scheduled: updating end time...");
    const r2 = await upsertDiscount(P2.title, P2.rate, startsPhase2, endsPhase2At, phase2Disc);
    ok("Phase 2 discount updated");
    log(`ID: ${r2?.id}`);
  }

  log("");
  warn("Run 'price-mark' before the sale starts to show slashed-through prices on product pages.");
  warn("Run 'price-restore' after the sale ends to clear compare-at prices.");
  console.log();
}

async function cmdSetPhase2() {
  console.log(`\n🏷️  Setting up phase 2 (${P2.percent}% site-wide)...\n`);

  const now      = new Date();
  const existing = await getSaleDiscounts();
  const phase2Disc   = existing.find(d => d.title === P2.title);
  const phase1Disc   = existing.find(d => d.title === P1.title);

  if (now >= PHASE2_START) {
    log(`Phase 2 start has passed. Activating ${P2.percent}% now.\n`);

    if (phase1Disc?.status === "ACTIVE") {
      log("Ending phase 1 discount...");
      await gql(UPDATE_DISCOUNT, {
        id: phase1Disc.id,
        input: makeDiscountInput(P1.title, P1.rate, phase1Disc.startsAt, now.toISOString()),
      });
      ok("Phase 1 discount ended");
    }

    const result = await upsertDiscount(P2.title, P2.rate, now.toISOString(), SALE_END.toISOString(), phase2Disc);
    ok(`${P2.percent}% site-wide sale is LIVE`);
    log(`Expires:  ${when(SALE_END)}`);
    log(`ID: ${result?.id}`);

  } else {
    const daysUntil = Math.ceil((PHASE2_START - now) / 864e5);
    log(`Phase 2 starts in ${daysUntil} day(s). Scheduling ${P2.percent}% to fire automatically.\n`);
    const result = await upsertDiscount(P2.title, P2.rate, PHASE2_START.toISOString(), SALE_END.toISOString(), phase2Disc);
    ok("Phase 2 discount scheduled");
    log(`Fires at: ${when(PHASE2_START)}`);
    log(`Expires:  ${when(SALE_END)}`);
    log(`ID:       ${result?.id}`);
    log("");
    warn("Phase 1 should already be scheduled. If not, run: set-phase1");
  }

  console.log();
}

async function cmdPriceMark() {
  console.log(`\n🏷️  Marking prices down ${P1.percent}% with strikethrough compare-at prices...\n`);

  if (existsSync(BACKUP_FILE)) {
    warn("Backup file already exists: price-mark may have already been run.");
    warn("Continuing will only update variants that don't yet have a compare-at price.\n");
  }

  log("Fetching all active products...");
  const products = await fetchAllProducts();
  log(`Found ${products.length} products.\n`);

  const backup = existsSync(BACKUP_FILE)
    ? JSON.parse(readFileSync(BACKUP_FILE, "utf8"))
    : {};

  let updated = 0;
  let skipped = 0;

  for (const product of products) {
    for (const variant of (product.variants ?? [])) {
      // Skip if already has a compare-at price (already marked down)
      if (variant.compare_at_price && parseFloat(variant.compare_at_price) > 0) {
        skipped++;
        continue;
      }

      const originalPrice = parseFloat(variant.price);
      if (!originalPrice || originalPrice <= 0) { skipped++; continue; }

      const salePrice = (originalPrice * (1 - P1.rate)).toFixed(2);

      // Store original for restoration
      backup[variant.id] = {
        product_id:          product.id,
        product_title:       product.title,
        original_price:      variant.price,
        original_compare_at: variant.compare_at_price ?? null,
      };
      // Persist before changing the price, so an interrupted run can still be restored
      writeFileSync(BACKUP_FILE, JSON.stringify(backup, null, 2));

      await rest("PUT", `/variants/${variant.id}.json`, {
        variant: {
          id: variant.id,
          price: salePrice,
          compare_at_price: variant.price, // original → strikethrough
        },
      });

      updated++;
      process.stdout.write(`\r  Updated ${updated} variants...`);
      await sleep(RATE_DELAY_MS);
    }
  }

  console.log();
  writeFileSync(BACKUP_FILE, JSON.stringify(backup, null, 2));

  console.log();
  ok(`${updated} variants updated: original price shows as strikethrough, sale price at ${P1.percent}% off`);
  if (skipped) log(`${skipped} variants skipped (already had compare-at price or $0)`);
  ok(`Backup saved → ${BACKUP_FILE}  (keep this safe for price-restore)`);
  console.log();
}

async function cmdPriceMarkPhase2() {
  console.log(`\n🏷️  Moving marked prices to ${P2.percent}% off for phase 2...\n`);

  if (!existsSync(BACKUP_FILE)) {
    die("Price backup not found. price-mark must be run first.");
  }

  const backup     = JSON.parse(readFileSync(BACKUP_FILE, "utf8"));
  const variantIds = Object.keys(backup);

  if (!variantIds.length) die("Backup file is empty.");

  log(`Updating ${variantIds.length} variants from original prices at ${P2.percent}% off...\n`);

  let updated = 0;
  let failed  = 0;

  for (const variantId of variantIds) {
    const { original_price, product_title } = backup[variantId];
    const origPrice = parseFloat(original_price);
    if (!origPrice || origPrice <= 0) continue;

    const salePrice = (origPrice * (1 - P2.rate)).toFixed(2); // phase 2 percentage off the original

    try {
      await rest("PUT", `/variants/${variantId}.json`, {
        variant: {
          id:               parseInt(variantId),
          price:            salePrice,
          compare_at_price: original_price, // keep original as strikethrough
        },
      });
      updated++;
      process.stdout.write(`\r  Updated ${updated}/${variantIds.length} variants...`);
      await sleep(RATE_DELAY_MS);
    } catch (err) {
      failed++;
      console.log(`\n  ⚠️  Failed: variant ${variantId} (${product_title}): ${err.message}`);
    }
  }

  console.log("\n");
  ok(`${updated} variants updated: prices now at ${P2.percent}% off (original still shown as strikethrough)`);
  if (failed) warn(`${failed} variants failed`);
  log("Run 'price-restore' after the sale to return everything to original prices.");
  console.log();
}

async function cmdPriceRestore() {
  console.log("\n🔄  Restoring original prices...\n");

  if (!existsSync(BACKUP_FILE)) {
    die("Price backup not found. Did you run price-mark?");
  }

  const backup     = JSON.parse(readFileSync(BACKUP_FILE, "utf8"));
  const variantIds = Object.keys(backup);

  if (!variantIds.length) die("Backup file is empty: nothing to restore.");

  log(`Restoring ${variantIds.length} variants...\n`);

  let restored = 0;
  let failed   = 0;

  for (const variantId of variantIds) {
    const { original_price, original_compare_at, product_title } = backup[variantId];

    try {
      await rest("PUT", `/variants/${variantId}.json`, {
        variant: {
          id: parseInt(variantId),
          price: original_price,
          compare_at_price: original_compare_at ?? "",
        },
      });
      restored++;
      process.stdout.write(`\r  Restored ${restored}/${variantIds.length} variants...`);
      await sleep(RATE_DELAY_MS);
    } catch (err) {
      failed++;
      console.log(`\n  ⚠️  Failed: variant ${variantId} (${product_title}): ${err.message}`);
    }
  }

  console.log("\n");
  ok(`${restored} variants restored to original prices`);
  if (failed) warn(`${failed} variants failed: check output above, backup preserved`);

  if (!failed) {
    const archive = BACKUP_FILE.replace(".json", `-archived-${Date.now()}.json`);
    writeFileSync(archive, readFileSync(BACKUP_FILE));
    unlinkSync(BACKUP_FILE);
    log(`Backup archived to: ${archive}`);
  }

  console.log();
}

async function cmdEnd() {
  console.log("\n🔚  Ending sale discounts...\n");
  const existing = await getSaleDiscounts();

  if (!existing.length) { warn("No sale discounts found."); return; }

  for (const d of existing) {
    if (d.status === "ACTIVE") {
      log(`Deactivating: ${d.title}`);
      const data = await gql(DEACTIVATE_DISCOUNT, { id: d.id });
      const errs = data.discountAutomaticDeactivate?.userErrors;
      if (errs?.length) die(JSON.stringify(errs));
      ok(`${d.title} → deactivated`);
    } else {
      log(`${d.title} is ${d.status}: skipping`);
    }
  }

  log("");
  warn("Don't forget to run 'price-restore' to remove the strikethrough prices.");
  console.log();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const cmd = process.argv[2];
const commands = {
  status:           cmdStatus,
  "set-phase1":     cmdSetPhase1,
  "set-phase2":     cmdSetPhase2,
  "price-mark":     cmdPriceMark,
  "price-mark-phase2":  cmdPriceMarkPhase2,
  "price-restore":  cmdPriceRestore,
  end:              cmdEnd,
};

if (!commands[cmd]) {
  console.log(`
Shopify Sale Manager

Usage: node src/sale-manager.js <command>

Discount scheduling:
  status             Show automatic discounts and whether a price backup exists
  set-phase1         Schedule phase 1 and pre-schedule phase 2
  set-phase2         Schedule phase 2 (activates immediately if its start has passed)
  end                Deactivate the sale discounts

Storefront price display:
  price-mark         Mark every variant down by the phase 1 percentage and set compare-at
                     (saves a backup first)
  price-mark-phase2  Move marked prices to the phase 2 percentage
  price-restore      Restore all original prices (run after the sale ends)

Typical flow:
  1. node src/sale-manager.js set-phase1     # schedule both discounts
  2. node src/sale-manager.js price-mark     # show strikethrough prices
     phase 1 goes live automatically, then phase 2 fires automatically
  3. node src/sale-manager.js end
  4. node src/sale-manager.js price-restore
`);
  process.exit(0);
}

commands[cmd]().catch(err => {
  console.error("\n❌  Error:", err.message);
  process.exit(1);
});
