#!/bin/bash
# 构建 Host ESM 入口和供 DSH ModuleLoader 使用的 Client CJS 包装。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DSH_ROOT="${DSH_CHECKOUT:-/Users/weicoz/.local/lib/node_modules/@deepseek-ai/dsh}"
DSH_NODE_MODULES="$DSH_ROOT/node_modules"
if [ ! -d "$DSH_NODE_MODULES/@deepseek-ai" ]; then
  echo "build: cannot locate DSH runtime dependencies under $DSH_NODE_MODULES" >&2
  exit 1
fi

TSC="${ROOT}/node_modules/.bin/tsc"
if [ ! -x "$TSC" ]; then
  TSC="$(find "$HOME/File" -path '*/node_modules/.pnpm/typescript@*/node_modules/typescript/bin/tsc' -type f 2>/dev/null | head -1)"
fi
if [ -z "${TSC:-}" ] || [ ! -f "$TSC" ]; then
  echo "build: TypeScript compiler not found; install devDependencies first" >&2
  exit 1
fi

link_package() {
  local package="$1"
  local target="$DSH_NODE_MODULES/$package"
  if [ ! -e "$target" ]; then
    echo "build: missing DSH dependency $package" >&2
    exit 1
  fi
  mkdir -p "$(dirname "node_modules/$package")"
  rm -rf "node_modules/$package"
  ln -s "$target" "node_modules/$package"
}

mkdir -p node_modules/@deepseek-ai node_modules/@types node_modules/.bin
for package in @deepseek-ai/cordis @deepseek-ai/schemastery @deepseek-ai/dsh-settings @deepseek-ai/dsh-client-runtime @deepseek-ai/dsh-client-ui-conversation @deepseek-ai/dsh-client-ui-settings react @types/node; do
  link_package "$package"
done

rm -rf lib .build-client
"$TSC" -p tsconfig.json
node <<'NODE'
const fs = require('fs')
const ts = require('typescript')
const source = fs.readFileSync('src/client/index.ts', 'utf8')
const result = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.CommonJS,
    esModuleInterop: true,
  },
  fileName: 'src/client/index.ts',
})
fs.mkdirSync('.build-client/client', { recursive: true })
fs.writeFileSync('.build-client/client/index.js', result.outputText)
NODE

{
  printf 'window.__ModuleLoader__.load({ id: %s, factory: (require) => {\n' "'@dsh-external/dsh-codex-composer'"
  printf 'var module = { exports: {} }; var exports = module.exports;\n'
  cat .build-client/client/index.js
  printf '\nreturn module.exports; } });\n'
} > lib/client.js
rm -rf .build-client

echo "build: complete"
