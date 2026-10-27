'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const call = (ch, ...a) => ipcRenderer.invoke('orion:' + ch, ...a);

contextBridge.exposeInMainWorld('orionDesktop', Object.freeze({
  isDesktop: true,
  platform: process.platform,
  arch: process.arch,
  info: () => call('app:info'),
  checkUpdate: () => call('app:checkUpdate'),
  openFolder: kind => call('app:openFolder', kind),
  workspace: { get: () => call('ws:get'), choose: () => call('ws:choose'), clear: () => call('ws:clear') },
  fs: { list: rel => call('fs:list', rel), read: rel => call('fs:read', rel), write: (rel, content) => call('fs:write', rel, content) },
  term: { run: command => call('term:run', command) },
  git: { run: sub => call('git:run', sub) },
  tools: { detect: () => call('tools:detect') },
  agent: { run: (id, prompt) => call('agent:run', id, prompt) },
  secret: {
    available: () => call('secret:available'),
    set: (name, value) => call('secret:set', name, value),
    get: name => call('secret:get', name),
    del: name => call('secret:del', name)
  },
  skills: { list: () => call('skills:list'), read: id => call('skills:read', id), install: mode => call('skills:install', mode) },
  plugins: { list: () => call('plugins:list'), install: () => call('plugins:install'), remove: id => call('plugins:remove', id) },
  mcp: {
    list: () => call('mcp:list'), add: (spec, token) => call('mcp:add', spec, token), remove: id => call('mcp:remove', id),
    start: id => call('mcp:start', id), stop: id => call('mcp:stop', id), call: (id, tool, args) => call('mcp:call', id, tool, args)
  },
  missions: {
    list: () => call('mission:list'),
    get: id => call('mission:get', id),
    create: spec => call('mission:create', spec),
    transition: (id, to, reason) => call('mission:transition', id, to, reason),
    pause: id => call('mission:pause', id),
    resume: id => call('mission:resume', id),
    cancel: id => call('mission:cancel', id),
    addTask: (id, task) => call('mission:addTask', id, task),
    addDependency: (id, taskId, depId) => call('mission:addDependency', id, taskId, depId),
    startTask: (id, taskId) => call('mission:startTask', id, taskId),
    succeedTask: (id, taskId, result, key) => call('mission:succeedTask', id, taskId, result, key),
    failTask: (id, taskId, error, retryable) => call('mission:failTask', id, taskId, error, retryable),
    outcomeUnknown: (id, taskId, reason) => call('mission:outcomeUnknown', id, taskId, reason),
    requestApproval: (id, taskId, action, resource, params, scope, ttlMs) => call('mission:requestApproval', id, taskId, action, resource, params, scope, ttlMs),
    resolveApproval: (id, approvalId, approved) => call('mission:resolveApproval', id, approvalId, approved),
    retryTask: (id, taskId) => call('mission:retryTask', id, taskId),
    validateApproval: (id, approvalId, action, resource, params, scope) => call('mission:validateApproval', id, approvalId, action, resource, params, scope),
    executeTask: (id, taskId, adapterConfig, taskPayload) => call('mission:executeTask', id, taskId, adapterConfig, taskPayload),
    executeNext: (id, adapterConfig, opts) => call('mission:executeNext', id, adapterConfig, opts)
  },
  rea: { doctor: version => call('rea:doctor', version) },
  web: {
    overview: () => call('web:overview'), config: { set: patch => call('web:config:set', patch) }, key: { set: (provider, value) => call('web:key:set', provider, value), del: provider => call('web:key:del', provider) },
    session: { start: spec => call('web:session:start', spec), end: id => call('web:session:end', id) },
    search: (sid, req) => call('web:search', sid, req), fetch: (sid, req) => call('web:fetch', sid, req), fetchUrl: req => call('data:fetchUrl', req)
  },
  discover: { search: req => call('discover:search', req), open: url => call('discover:open', url) },
  setExperimental: (name, on) => call('app:setExperimental', name, on),
  api: {
    overview: () => call('api:overview'),
    catalog: { list: f => call('api:catalog:list', f), sync: () => call('api:catalog:sync'), importFile: () => call('api:catalog:importFile') },
    connector: {
      review: (input, catalogId) => call('api:connector:review', input, catalogId), update: (id, patch) => call('api:connector:update', id, patch),
      test: id => call('api:connector:test', id), enable: id => call('api:connector:enable', id), disable: id => call('api:connector:disable', id),
      revoke: id => call('api:connector:revoke', id), remove: id => call('api:connector:remove', id)
    },
    secret: { set: (id, name, value) => call('api:secret:set', id, name, value), has: (id, name) => call('api:secret:has', id, name), del: (id, name) => call('api:secret:del', id, name) },
    mission: { start: spec => call('api:mission:start', spec), end: id => call('api:mission:end', id) },
    call: (missionId, req) => call('api:call', missionId, req),
    stop: () => call('api:stop'), resume: () => call('api:resume'),
    audit: { tail: n => call('api:audit:tail', n), verify: () => call('api:audit:verify') }
  },
  connectors: { presets: () => call('connectors:presets') },
  memory: {
    create: (rec, scope) => call('memory:create', rec, scope),
    get: (id, scope) => call('memory:get', id, scope),
    list: (filters) => call('memory:list', filters),
    search: (query, filters) => call('memory:search', query, filters),
    update: (id, patch, scope) => call('memory:update', id, patch, scope),
    supersede: (id, reason, scope) => call('memory:supersede', id, reason, scope),
    remove: (id, scope) => call('memory:delete', id, scope),
    conflicts: (rec, scope) => call('memory:conflicts', rec, scope)
  },
  skillVersion: {
    register: (manifest, body) => call('skillversion:register', manifest, body),
    list: (filter) => call('skillversion:list', filter),
    get: (versionId) => call('skillversion:get', versionId),
    evaluate: (versionId) => call('skillversion:evaluate', versionId),
    activate: (versionId) => call('skillversion:activate', versionId),
    deactivate: (versionId) => call('skillversion:deactivate', versionId),
    quarantine: (versionId, reason) => call('skillversion:quarantine', versionId, reason),
    rollback: (versionId) => call('skillversion:rollback', versionId),
    active: (skillId) => call('skillversion:active', skillId),
    backup: () => call('skillversion:backup')
  },
  central: {
    status: () => call('central:status'),
    setToken: (token) => call('central:setToken', token),
    clearToken: () => call('central:clearToken'),
    enqueue: (type, payload) => call('central:enqueue', type, payload),
    sync: () => call('central:sync'),
    pull: (after) => call('central:pull', after),
    migrateLocal: (opts) => call('central:migrateLocal', opts),
    // Phase C — Desktop ↔ Central (device token, outbox, SSE/delta sync)
    desktopStatus: () => call('central:desktopStatus'),
    desktopLogin: (token) => call('central:desktopLogin', token),
    desktopLogout: () => call('central:desktopLogout'),
    desktopSetUrl: (url) => call('central:desktopSetUrl', url),
    desktopList: () => call('central:desktopList'),
    desktopGet: (id) => call('central:desktopGet', id),
    desktopCreate: (title, clientKey) => call('central:desktopCreate', title, clientKey),
    desktopUpdate: (id, patch) => call('central:desktopUpdate', id, patch),
    desktopRemove: (id) => call('central:desktopRemove', id),
    desktopSend: (conversationId, msg) => call('central:desktopSend', conversationId, msg),
    desktopSync: () => call('central:desktopSync'),
    desktopImport: (convos) => call('central:desktopImport', convos),
    onEvent: (cb) => { const h = (_e, ev) => cb(ev); ipcRenderer.on('orion:central:event', h); return () => ipcRenderer.removeListener('orion:central:event', h); }
  },
  onMenu: cb => { ipcRenderer.on('orion:menu', (_e, m) => cb(m)); }
}));
