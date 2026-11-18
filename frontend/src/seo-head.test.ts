import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8')
}

function pngSize(relativePath: string): { width: number; height: number } {
  const buf = readFileSync(resolve(root, relativePath))
  expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  expect(buf.subarray(12, 16).toString('ascii')).toBe('IHDR')
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

describe('public SEO files', () => {
  it('points robots.txt at the real sitemap and drops the domain placeholder', () => {
    const robots = read('public/robots.txt')
    expect(robots).toContain('Sitemap: https://satstreamr.com/sitemap.xml')
    expect(robots).not.toContain('your-domain')
    expect(robots).toContain('Disallow: /room.html')
  })

  it('lists only the public HTML pages in sitemap.xml', () => {
    const sitemap = read('public/sitemap.xml')
    expect(sitemap).toContain('<loc>https://satstreamr.com/</loc>')
    expect(sitemap).toContain('<loc>https://satstreamr.com/about.html</loc>')
    expect(sitemap).not.toContain('room.html')
    expect(sitemap).not.toContain('tutor.html')
    expect(sitemap).not.toContain('viewer.html')
    expect(sitemap.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
  })

  it('ships a 1200x630 Open Graph image', () => {
    expect(pngSize('public/og-image.png')).toEqual({ width: 1200, height: 630 })
  })
})

describe('page metadata', () => {
  const home = read('index.html')
  const about = read('about.html')
  const room = read('room.html')

  it('gives the homepage a descriptive title, description, canonical, and h1', () => {
    expect(home).toMatch(
      /<title>Satstreamr — Streaming Payments with Cashu and Lightning<\/title>/
    )
    expect(home).toContain('name="description"')
    expect(home).toContain('<link rel="canonical" href="https://satstreamr.com/" />')
    expect(home).toContain('<h1>Satstreamr</h1>')
  })

  it('gives the about page a descriptive title, description, canonical, and h1', () => {
    expect(about).toMatch(/<title>How Satstreamr Works —/)
    expect(about).toContain('name="description"')
    expect(about).toContain(
      '<link rel="canonical" href="https://satstreamr.com/about.html" />'
    )
    expect(about).toContain('<h1>How Satstreamr Works</h1>')
  })

  it('completes Open Graph and Twitter card tags on public pages', () => {
    for (const html of [home, about]) {
      expect(html).toContain('property="og:title"')
      expect(html).toContain('property="og:description"')
      expect(html).toContain('property="og:url"')
      expect(html).toContain(
        'property="og:image" content="https://satstreamr.com/og-image.png"'
      )
      expect(html).toContain('name="twitter:card" content="summary_large_image"')
      expect(html).toContain('name="twitter:image" content="https://satstreamr.com/og-image.png"')
    }
  })

  it('describes the homepage as a WebApplication', () => {
    expect(home).toContain('"@type": "WebApplication"')
    expect(home).toContain('"url": "https://satstreamr.com/"')
  })

  it('keeps the session room out of the index and gives it a canonical URL', () => {
    expect(room).toContain('name="robots" content="noindex"')
    expect(room).toContain('<link rel="canonical" href="https://satstreamr.com/room.html" />')
    expect(room).toContain('<h1>Satstreamr — Room</h1>')
    expect(room).toContain('name="description"')
  })
})
