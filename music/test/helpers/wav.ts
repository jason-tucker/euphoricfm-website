// Minimal RIFF/WAVE builder for crafted (often hostile) WAV fixtures: exact
// control over the fmt chunk, extra chunks, their order and every size field.

export type Chunk = { id: string; body: Buffer; size?: number } // size overrides the declared size

export function chunk(id: string, body: Buffer, size?: number): Buffer {
  const h = Buffer.alloc(8)
  h.write(id, 0, 'latin1')
  h.writeUInt32LE(size ?? body.length, 4)
  return Buffer.concat([h, body, body.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)])
}

export type Fmt = { tag?: number; channels?: number; rate?: number; bits?: number; blockAlign?: number; byteRate?: number; extensible?: { subTag: number; validBits?: number; guidTail?: Buffer } }

const KS_TAIL = Buffer.from([0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71])

export function fmtBody(f: Fmt = {}): Buffer {
  const channels = f.channels ?? 2
  const rate = f.rate ?? 44100
  const bits = f.bits ?? 16
  const blockAlign = f.blockAlign ?? channels * (bits / 8)
  const byteRate = f.byteRate ?? rate * blockAlign
  const b = Buffer.alloc(f.extensible ? 40 : 16)
  b.writeUInt16LE(f.extensible ? 0xfffe : (f.tag ?? 1), 0)
  b.writeUInt16LE(channels, 2)
  b.writeUInt32LE(rate, 4)
  b.writeUInt32LE(byteRate, 8)
  b.writeUInt16LE(blockAlign, 12)
  b.writeUInt16LE(bits, 14)
  if (f.extensible) {
    b.writeUInt16LE(22, 16)
    b.writeUInt16LE(f.extensible.validBits ?? bits, 18)
    b.writeUInt32LE(channels === 2 ? 3 : 0, 20)
    b.writeUInt32LE(f.extensible.subTag, 24)
    ;(f.extensible.guidTail ?? KS_TAIL).copy(b, 28)
  }
  return b
}

// 16-bit sine PCM, `seconds` long.
export function sinePcm16(seconds: number, rate = 44100, channels = 2, freq = 440): Buffer {
  const n = Math.round(seconds * rate)
  const b = Buffer.alloc(n * channels * 2)
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 12000)
    for (let c = 0; c < channels; c++) b.writeInt16LE(v, (i * channels + c) * 2)
  }
  return b
}

// RIFF/WAVE from pre-built chunk buffers; `riffSize` overrides the header.
export function riff(chunks: Buffer[], riffSize?: number): Buffer {
  const body = Buffer.concat([Buffer.from('WAVE', 'latin1'), ...chunks])
  const h = Buffer.alloc(8)
  h.write('RIFF', 0, 'latin1')
  h.writeUInt32LE(riffSize ?? body.length, 4)
  return Buffer.concat([h, body])
}

// A plain valid 16-bit WAV with optional extra chunks before / after 'data'.
export function simpleWav(opts: { seconds?: number; rate?: number; channels?: number; before?: Buffer[]; after?: Buffer[] } = {}): Buffer {
  const rate = opts.rate ?? 44100
  const channels = opts.channels ?? 2
  return riff([chunk('fmt ', fmtBody({ rate, channels })), ...(opts.before ?? []), chunk('data', sinePcm16(opts.seconds ?? 35, rate, channels)), ...(opts.after ?? [])])
}

// LIST/INFO from [id, text] pairs (NUL-terminated, padded).
export function infoList(items: [string, string][]): Buffer {
  return chunk('LIST', Buffer.concat([Buffer.from('INFO', 'latin1'), ...items.map(([id, v]) => chunk(id, Buffer.from(`${v}\0`, 'latin1')))]))
}
