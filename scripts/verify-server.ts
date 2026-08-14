const base = 'http://127.0.0.1:8080'
for (const url of ['/health', '/', '/api/monitor_objects', '/api/monitor_objects/1/groups']) {
  try {
    const res = await fetch(base + url)
    const text = await res.text()
    console.log(`${url} -> ${res.status}  ${text.slice(0, 150).replace(/\n/g, ' ')}`)
  } catch (e: any) {
    console.log(`${url} -> ERROR ${e.message}`)
  }
}
