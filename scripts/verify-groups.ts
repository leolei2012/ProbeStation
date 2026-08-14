const gs = await (await fetch('http://127.0.0.1:8080/api/monitor_objects/2/groups')).json()
console.log('groups:', JSON.stringify(gs.map((g: any) => ({ name: g.name, start: g.startAddress, qty: g.quantity }))))
const lat = await (await fetch('http://127.0.0.1:8080/api/monitor_objects/2/latest')).json()
console.log('latest keys:', JSON.stringify(Object.keys(lat)))
