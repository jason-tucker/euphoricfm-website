// Minimal ID3v2 tag builder for hostile-input fixtures.
import { deflateSync } from 'node:zlib'

export function syncsafe(n: number): Buffer {
  return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f])
}

export function frameV3(id: string, data: Buffer, flags = 0): Buffer {
  const h = Buffer.alloc(10)
  h.write(id, 0, 'latin1')
  h.writeUInt32BE(data.length, 4)
  h.writeUInt16BE(flags, 8)
  return Buffer.concat([h, data])
}

export function frameV4(id: string, data: Buffer, flags = 0): Buffer {
  const h = Buffer.alloc(10)
  h.write(id, 0, 'latin1')
  syncsafe(data.length).copy(h, 4)
  h.writeUInt16BE(flags, 8)
  return Buffer.concat([h, data])
}

export const textV3 = (s: string) => Buffer.concat([Buffer.from([0x00]), Buffer.from(s, 'latin1')])

export function apicV3(mime: string, data: Buffer, pictureType = 3): Buffer {
  return Buffer.concat([Buffer.from([0x00]), Buffer.from(mime, 'latin1'), Buffer.from([0x00, pictureType]), Buffer.from('cover', 'latin1'), Buffer.from([0x00]), data])
}

export function tag(major: 3 | 4, frames: Buffer[], padding = 0): Buffer {
  const body = Buffer.concat([...frames, Buffer.alloc(padding)])
  return Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([major, 0, 0]), syncsafe(body.length), body])
}

// ID3v2.4 TXXX frame whose payload is zlib-compressed `inflated` zero bytes:
// flags 0x0009 = compression + data-length indicator.
export function zlibBombFrame(inflated: number): Buffer {
  const payload = Buffer.concat([Buffer.from([0x03]), Buffer.from('bomb\0', 'utf8'), Buffer.alloc(inflated)])
  const z = deflateSync(payload, { level: 9 })
  return frameV4('TXXX', Buffer.concat([syncsafe(payload.length), z]), 0x0009)
}
