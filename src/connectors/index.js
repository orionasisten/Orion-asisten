'use strict';
/* Perakitan API Connector Hub: guard + registry + audit + secrets + gateway + katalog. */
const path = require('path');
const { createNetGuard } = require('./netguard');
const { createRegistry } = require('./registry');
const { createAudit } = require('./audit');
const { createSecretStore } = require('./secrets');
const { createGateway } = require('./gateway');
const transport = require('./transport');
const { parsePublicApis } = require('./catalog');

const CATALOG_URL = 'https://github.com/public-apis/public-apis/raw/refs/heads/master/README.md';
const CATALOG_HOSTS = ['github.com', 'raw.githubusercontent.com'];

function createConnectorHub(o) { // o: { dir, approve, secretsBacking, version, guardOptions, transport, now, nowMs, sleep }
  const guard = createNetGuard(o.guardOptions);
  const registry = createRegistry({ file: path.join(o.dir, 'connectors.json'), guard, now: o.now });
  const secrets = createSecretStore(o.secretsBacking);
  const audit = createAudit({ file: path.join(o.dir, 'connector-audit.jsonl'), now: o.now });
  const gateway = createGateway({ registry, secrets, audit, guard, approve: o.approve, transport: o.transport || transport, now: o.now, nowMs: o.nowMs, sleep: o.sleep, version: o.version });

  function importText(md, meta) {
    const r = parsePublicApis(md, meta);
    if (!r.entries.length) throw new Error(`Format README tidak dikenali (0 entri dari ${r.stats.rows} baris tabel). Katalog tidak diubah.`);
    const imp = registry.importCatalog(r.entries, meta);
    audit.record({ kind: 'catalog.import', source: 'public-apis/public-apis', sha256: (meta && meta.sha256) || null, parsed: r.stats.parsed, skipped: r.stats.skipped, added: imp.added, updated: imp.updated });
    return Object.assign({}, imp, r.stats);
  }

  async function syncCatalog() { // pemanggil WAJIB sudah meminta persetujuan pengguna
    const r = await gateway.systemGet(CATALOG_URL, { allowedHosts: CATALOG_HOSTS, purpose: 'catalog-sync' });
    return importText(r.text, { syncedAt: (o.now || (() => new Date().toISOString()))(), sha256: r.sha256 });
  }

  function revoke(id) {
    registry.revoke(id); secrets.deleteAll(id);
    audit.record({ kind: 'connector.revoke', connectorId: id });
    return registry.get(id);
  }

  function view(c) { // tampilan aman untuk UI (tanpa nilai secret)
    return Object.assign({}, c, { secretStatus: (c.requiredSecrets || []).reduce((a, n) => { a[n] = secrets.has(c.id, n); return a; }, {}) });
  }

  return { guard, registry, secrets, audit, gateway, importText, syncCatalog, revoke, view, CATALOG_URL };
}

module.exports = { createConnectorHub, CATALOG_URL, CATALOG_HOSTS };
