import type { NextConfig } from 'next'

const config: NextConfig = {
  transpilePackages: ['@cornhole/engine'],
  webpack(cfg) {
    // Engine sources use .js import extensions (ESM convention) — resolve them to .ts
    cfg.resolve.extensionAlias = {
      '.js': ['.ts', '.js'],
      '.jsx': ['.tsx', '.jsx'],
    }
    return cfg
  },
}

export default config
