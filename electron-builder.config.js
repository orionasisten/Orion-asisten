'use strict';
/**
 * Dua profil build:
 *   modern (default)  -> Electron terbaru, untuk Windows & macOS yang masih didukung Chromium.
 *   legacy            -> Electron 22.x (Chromium 108): Windows 7/8/8.1 dan macOS 10.13+.
 * Pilih profil lewat env ORION_PROFILE=legacy (lihat script dist:*:legacy).
 */
const legacy = process.env.ORION_PROFILE === 'legacy';
const tag = legacy ? '-legacy' : '';
// Auto-update: isi ORION_UPDATE_REPO=owner/repo (di GitHub Actions otomatis = repo itu sendiri).
const updateRepo = process.env.ORION_UPDATE_REPO || '';
const [ghOwner, ghRepo] = updateRepo.split('/');

const mac = {
  category: 'public.app-category.productivity',
  icon: 'build/icon.png',
  target: [
    { target: 'dmg', arch: ['universal'] },
    { target: 'zip', arch: ['universal'] }
  ],
  hardenedRuntime: true,
  gatekeeperAssess: false,
  entitlements: 'build/entitlements.mac.plist',
  entitlementsInherit: 'build/entitlements.mac.plist',
  extendInfo: {
    NSMicrophoneUsageDescription: 'ORION memakai mikrofon untuk fitur Voice.'
  }
};
if (legacy) mac.minimumSystemVersion = '10.13.0';
// Notarisasi hanya aktif jika kredensial Apple tersedia di environment.
if (process.env.APPLE_TEAM_ID && process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD) {
  mac.notarize = true;
}

// Linux: x64 secara default; arm64 hanya bila ORION_LINUX_ARM64=1 (pengemasan lintas-arsitektur lebih rentan gagal).
const linuxArch = process.env.ORION_LINUX_ARM64 === '1' ? ['x64', 'arm64'] : ['x64'];

module.exports = {
  appId: 'id.digium.orion',
  productName: 'ORION',
  copyright: 'Copyright © DIGIUM',
  directories: { output: `dist/${legacy ? 'legacy' : 'modern'}`, buildResources: 'build' },
  // pg (driver PostgreSQL) HANYA dipakai proses server Orion Central — tidak perlu di paket desktop.
  files: ['src/**/*', 'app/**/*', 'package.json', '!**/*.map',
    '!**/node_modules/pg/**', '!**/node_modules/pg-*/**', '!**/node_modules/postgres-*/**',
    '!**/node_modules/pgpass/**', '!**/node_modules/split2/**', '!**/node_modules/xtend/**'],
  extraResources: [{ from: 'resources', to: 'resources', filter: ['**/*'] }],
  asar: true,
  compression: 'normal',
  artifactName: `ORION-\${version}-\${os}-\${arch}${tag}.\${ext}`,
  // Metadata ini ikut masuk package.json di dalam aplikasi dan dibaca src/updater.js saat runtime.
  // homepage dibutuhkan paket .deb; ganti dengan situs/repo Anda.
  extraMetadata: { orionProfile: legacy ? 'legacy' : 'modern', orionRepo: updateRepo || undefined, homepage: updateRepo ? 'https://github.com/' + updateRepo : 'https://localhost/orion' },
  // Hanya menghasilkan berkas pembaruan (latest*.yml / blockmap); upload dilakukan workflow (--publish never).
  publish: updateRepo && ghOwner && ghRepo
    ? [{ provider: 'github', owner: ghOwner, repo: ghRepo, releaseType: 'release', ...(legacy ? { channel: 'legacy' } : {}) }]
    : null,

  win: {
    icon: 'build/icon.ico',
    /* ORION_TARGET (dipakai scripts build:win:*) mempersempit target tanpa mengubah config:
     *   installer -> NSIS x64 saja; portable -> portable x64 saja; tidak diset -> semuanya (dist:win). */
    target: process.env.ORION_TARGET === 'installer' ? [{ target: 'nsis', arch: ['x64'] }]
      : process.env.ORION_TARGET === 'portable' ? [{ target: 'portable', arch: ['x64'] }]
      : [
        { target: 'nsis', arch: legacy ? ['x64', 'ia32'] : ['x64', 'arm64'] },
        { target: 'portable', arch: ['x64'] },
        { target: 'zip', arch: ['x64'] }
      ]
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: true,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'ORION',
    artifactName: `ORION-Setup-\${version}-\${arch}${tag}.\${ext}`,
    deleteAppDataOnUninstall: false
  },
  portable: { artifactName: `ORION-Portable-\${version}-\${arch}${tag}.\${ext}` },

  linux: {
    icon: 'build/icon.png',
    category: 'Office',
    // Ganti email di bawah dengan milik Anda (wajib berformat valid untuk paket .deb).
    maintainer: 'DIGIUM <noreply@digium.invalid>',
    synopsis: 'ORION — AI Strategic Partner',
    description: 'ORION Desktop: asisten strategis AI dengan skill, plugin, connector, MCP, dan API Hub.',
    target: [
      { target: 'AppImage', arch: linuxArch },
      { target: 'deb', arch: linuxArch },
      { target: 'tar.gz', arch: linuxArch }
    ]
  },

  mac,
  dmg: { title: 'ORION ${version}', writeUpdateInfo: false }
};
