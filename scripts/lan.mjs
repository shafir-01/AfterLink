import { spawn } from 'node:child_process'
import { networkInterfaces } from 'node:os'

const port = process.env.PORT ?? '8787'
const isLan = (a) => /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))\./.test(a)
const addrs = Object.values(networkInterfaces())
  .flat()
  .filter((n) => n && n.family === 'IPv4' && !n.internal)
  .map((n) => n.address)
  .sort((a, b) => Number(isLan(b)) - Number(isLan(a)))

if (!addrs.length) {
  console.error('No LAN address found. Connect to a network first.')
  process.exit(1)
}
console.log('\nSame-room demo. Open on every device (same Wi-Fi):\n')
for (const a of addrs) console.log(`  http://${a}:${port}`)
console.log('\nLead device: /#/lead   Field devices: /#/device\n')

const child = spawn('npm', ['run', 'start', '-w', '@afterlink/relay'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, HOST: '0.0.0.0', PORT: port },
})
child.on('exit', (code) => process.exit(code ?? 0))
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => child.kill(s))
