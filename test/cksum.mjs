// POSIX cksum line of a text, "<crc> <bytes>". Tests use it instead of starting the cksum command.
const table = Array.from({ length: 256 }, (_, n) => {
  let c = n << 24
  for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04C11DB7 : c << 1
  return c >>> 0
})

export default function cksum(input) {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input)
  let crc = 0
  const feed = b => { crc = ((crc << 8) ^ table[((crc >>> 24) ^ b) & 255]) >>> 0 }
  for (const b of bytes) feed(b)
  for (let n = bytes.length; n > 0; n = Math.floor(n / 256)) feed(n & 255)
  return `${(~crc) >>> 0} ${bytes.length}`
}
