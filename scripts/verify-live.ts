const base = 'http://127.0.0.1:8080'
const get = async (url: string) => { const r = await fetch(base + url); return r.status + ' ' + (await r.text()).slice(0, 200) }

console.log('objects:', await get('/api/monitor_objects'))
const a = await get('/api/monitor_objects/2/latest')
console.log('sim latest (t1):', a)
await new Promise((r) => setTimeout(r, 2500))
const b = await get('/api/monitor_objects/2/latest')
console.log('sim latest (t2):', b)
