import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import net from 'node:net';
import ts from 'typescript';
import Fastify from 'fastify';
import { ConfigStore } from '../packages/config/src/index.ts';
import { ActivationUncertainError } from '../apps/web/src/activation-settings-save.ts';
import { draftEditor, draftSurface } from './fixtures/draft-navigation-driver.ts';
// Use only fresh native SQLite fixtures and in-process Fastify injection.
// The second connection reads during DELETE triggers, before the writer commits.
// This models overlapping reads without claiming a real multi-process/browser test.
type Kind = 'device' | 'group' | 'register';
const kinds: Kind[] = ['device', 'group', 'register'], tables = ['monitor_objects', 'register_groups', 'registers', 'alarm_rules', 'logs', 'firmwares'];
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const caught = (action: () => unknown) => { try {
    action();
    return { threw: false, error: undefined };
}
catch (error) {
    return { threw: true, error };
} };
const snapshot = (db: DatabaseSync) => JSON.stringify(Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()])));
const failures: string[] = [], passed: string[] = [], unhandled: unknown[] = [], denied: string[] = [];
const check = async (name: string, action: () => void | Promise<void>) => { try {
    await action();
    passed.push(name);
    console.log('DELETE COMPOSITION OK: ' + name);
}
catch (error) {
    failures.push(name + ': ' + (error instanceof Error ? error.message : String(error)));
    console.log('DELETE COMPOSITION REPRO: ' + failures.at(-1));
} };
function fixture(file = false) {
    const directory = file ? mkdtempSync(join(tmpdir(), 'probestation-delete-composition-')) : undefined;
    let armed = false, failNotify = false, db!: DatabaseSync, reader: DatabaseSync | undefined;
    const notifications: {
        transaction: boolean;
        state: string;
    }[] = [], notifyFailure = Error('synthetic notification failure');
    const cfg = new ConfigStore({ dbPath: directory ? join(directory, 'synthetic.sqlite') : ':memory:' }, () => { if (armed) {
        notifications.push({ transaction: db.isTransaction, state: snapshot(reader ?? db) });
        if (failNotify)
            throw notifyFailure;
    } });
    const d = cfg.createObject('target', 'mock.invalid', 502), keep = cfg.createObject('keep', 'keep.mock.invalid', 502), g = cfg.createGroup(d.id, 'target', 3, 0, 2), sibling = cfg.createGroup(d.id, 'sibling', 3, 10, 1), other = cfg.createGroup(keep.id, 'other', 3, 0, 1);
    const points = [cfg.createRegister(g.id, d.id, 'first', 3, 0, 'uint16'), cfg.createRegister(g.id, d.id, 'second', 3, 1, 'uint16'), cfg.createRegister(sibling.id, d.id, 'sibling', 3, 10, 'uint16'), cfg.createRegister(other.id, keep.id, 'other', 3, 0, 'uint16')];
    const rules = points.map(point => cfg.createRule(point.id, '>', 1, 'keep scope'));
    cfg.log('INFO', 'synthetic', 'keep log');
    db = (cfg as unknown as {
        db: DatabaseSync;
    }).db;
    db.exec("INSERT INTO firmwares(name,size,file_path) VALUES('keep',1,'not-a-real-file'); PRAGMA busy_timeout=0");
    if (directory) {
        reader = new DatabaseSync(join(directory, 'synthetic.sqlite'), { readOnly: true });
        reader.exec('PRAGMA busy_timeout=0');
    }
    const before = snapshot(db), remove = (kind: Kind) => kind === 'device' ? cfg.deleteObject(d.id) : kind === 'group' ? cfg.deleteGroup(g.id) : cfg.deleteRegister(points[0].id);
    const expected = (kind: Kind) => { const value = JSON.parse(before), ids: Record<string, number[]> = { monitor_objects: kind === 'device' ? [d.id] : [], register_groups: kind === 'device' ? [g.id, sibling.id] : kind === 'group' ? [g.id] : [], registers: kind === 'device' ? points.slice(0, 3).map(p => p.id) : kind === 'group' ? points.slice(0, 2).map(p => p.id) : [points[0].id], alarm_rules: kind === 'device' ? rules.slice(0, 3).map(r => r.id) : kind === 'group' ? rules.slice(0, 2).map(r => r.id) : [rules[0].id] }; for (const table of tables)
        value[table] = value[table].filter((row: {
            id: number;
        }) => !(ids[table] ?? []).includes(row.id)); return JSON.stringify(value); };
    const failPoint = () => db.exec(`CREATE TRIGGER synthetic_fail BEFORE DELETE ON registers WHEN OLD.id=${points[0].id} BEGIN SELECT RAISE(ABORT,'synthetic DELETE failure'); END`);
    return { cfg, db, reader, d, keep, g, sibling, points, rules, before, expected, remove, failPoint, notifyFailure, notifications, arm: () => { armed = true; }, failNotify: () => { failNotify = true; }, close: async () => { if (reader) {
            if (reader.isTransaction)
                reader.exec('ROLLBACK');
            reader.close();
        } if (db.isTransaction)
            db.exec('ROLLBACK'); await cfg.close(); if (directory) {
            const target = resolve(directory), parent = resolve(tmpdir());
            assert.equal(dirname(target).toLowerCase(), parent.toLowerCase());
            assert(basename(target).startsWith('probestation-delete-composition-'));
            assert(lstatSync(target).isDirectory() && !lstatSync(target).isSymbolicLink());
            rmSync(target, { recursive: true, force: true });
        } } };
}
const configSource = ts.createSourceFile('config.ts', readFileSync(new URL('../packages/config/src/index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
function find(node: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node | undefined { if (predicate(node))
    return node; let result: ts.Node | undefined; ts.forEachChild(node, child => { result ??= find(child, predicate); }); return result; }
const legacy = (kind: Kind, db: DatabaseSync, id: number) => { const name = kind === 'device' ? 'deleteObject' : kind === 'group' ? 'deleteGroup' : 'deleteRegister', method = find(configSource, node => ts.isMethodDeclaration(node) && node.name.getText(configSource) === name)!, call = find(method, node => ts.isCallExpression(node) && node.expression.getText(configSource) === 'this.deleteAtomically') as ts.CallExpression; assert(call); const action = call.arguments[0] as ts.ArrowFunction; assert(ts.isBlock(action.body)); const statements = action.body.statements.map(statement => statement.getText(configSource)).join('\n').replaceAll('this.db', 'db'); new Function('db', 'id', statements)(db, id); };
const apiSource = ts.createSourceFile('api.ts', readFileSync(new URL('../packages/api/src/index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const routes = new Map<string, string>();
function collect(node: ts.Node) { if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'delete' && ts.isStringLiteral(node.arguments[0]))
    routes.set(node.arguments[0].text, node.getText(apiSource)); ts.forEachChild(node, collect); }
collect(apiSource);
function apiFor(f: ReturnType<typeof fixture>, kind: Kind) { const app = Fastify(), path = kind === 'device' ? '/api/monitor_objects/:id' : kind === 'group' ? '/api/groups/:id' : '/api/registers/:id', route = routes.get(path); assert(route); new Function('fastify', 'cfg', 'ctx', ts.transpileModule(route, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText)(app, f.cfg, { get: () => ({ async sync() { } }) }); return { app, url: path.replace(':id', String(kind === 'device' ? f.d.id : kind === 'group' ? f.g.id : f.points[0].id)) }; }
const appSource = ts.createSourceFile('App.tsx', readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const groupNode = find(appSource, node => ts.isVariableDeclaration(node) && node.name.getText(appSource) === 'deleteGroup') as ts.VariableDeclaration, operationNode = find(appSource, node => ts.isFunctionDeclaration(node) && node.name?.text === 'useOperation')!;
const evaluate = (node: ts.Node, scope: Record<string, unknown>) => new Function(...Object.keys(scope), ts.transpileModule('return (' + node.getText(appSource) + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText)(...Object.values(scope));
function groupUi(english: boolean, send: (url: string) => Promise<unknown>, refresh: () => void, groups: unknown[], answer = true) { const notices: {
    error: boolean;
    text: string;
}[] = []; let prompts = 0; const t = (key: string) => key === 'cancel' ? (english ? 'Cancel' : '取消') : key === 'operationOk' ? 'OK' : key === 'operationFailed' ? (english ? 'Operation failed' : '操作失败') : key === 'confirmDeleteGroup' ? 'Delete {name}' : key; const operation = evaluate(operationNode, { useState: (value: unknown) => [value, () => { }], useRef: (value: unknown) => ({ current: value }), showOperationNotice: (value: {
        error: boolean;
        text: string;
    }) => notices.push(value), ActivationUncertainError })(t); const remove = evaluate(groupNode.initializer!, { groups, window: { confirm() { prompts++; return answer; } }, operation, t, api: { del: send }, onRefresh: refresh }); return { remove, notices, prompts: () => prompts }; }
const onUnhandled = (error: unknown) => { unhandled.push(error); }, listen = net.Server.prototype.listen, connect = net.Socket.prototype.connect, fetch = globalThis.fetch, block = (name: string) => () => { denied.push(name); throw Error('unexpected real I/O: ' + name); };
net.Server.prototype.listen = block('listen') as typeof listen;
net.Socket.prototype.connect = block('connect') as typeof connect;
globalThis.fetch = block('fetch') as typeof fetch;
process.on('unhandledRejection', onUnhandled);
try {
    for (const kind of kinds)
        for (const mode of ['legacy-reference', 'atomic-success', 'atomic-failure', 'notify-failure'])
            await check(kind + '/' + mode, async () => {
                const f = fixture(true), reads: string[] = [];
                try {
                    const reader = f.reader!;
                    f.db.function('synthetic_observe', () => { reads.push(snapshot(reader)); return 0; });
                    for (const table of ['alarm_rules', 'registers', 'register_groups', 'monitor_objects'])
                        f.db.exec(`CREATE TEMP TRIGGER observe_${table} AFTER DELETE ON ${table} BEGIN SELECT synthetic_observe(); END`);
                    if (mode === 'atomic-failure')
                        f.failPoint();
                    if (mode === 'notify-failure')
                        f.failNotify();
                    f.arm();
                    const result = caught(() => mode === 'legacy-reference' ? legacy(kind, f.db, kind === 'device' ? f.d.id : kind === 'group' ? f.g.id : f.points[0].id) : f.remove(kind));
                    assert(reads.length > 0);
                    if (mode === 'legacy-reference') {
                        assert.equal(result.threw, false);
                        assert(reads.some(state => state !== f.before && state !== f.expected(kind)), 'the reader fixture must detect partial independent-statement deletion');
                        assert.equal(f.notifications.length, 0);
                    }
                    else {
                        assert(reads.every(state => state === f.before), 'a separate connection must not observe uncommitted intermediate deletion');
                        if (mode === 'atomic-failure') {
                            assert.equal(result.threw, true);
                            assert.equal(snapshot(reader), f.before);
                            assert.equal(snapshot(f.db), f.before);
                            assert.equal(f.notifications.length, 0);
                        }
                        else {
                            assert.equal(result.threw, mode === 'notify-failure');
                            assert.equal(snapshot(reader), f.expected(kind));
                            assert.equal(snapshot(f.db), f.expected(kind));
                            assert.equal(f.notifications.length, 1);
                            assert.equal(f.notifications[0].transaction, false);
                            assert.equal(f.notifications[0].state, f.expected(kind));
                            if (mode === 'notify-failure')
                                assert(result.error instanceof Error && result.error.message.includes('已提交') && result.error.cause === f.notifyFailure);
                        }
                    }
                }
                finally {
                    await f.close();
                }
            });
    await check('held-reader-lock-failure-and-explicit-recovery', async () => { const f = fixture(true); try {
        assert.equal(String(f.db.prepare('PRAGMA journal_mode').get()?.journal_mode), 'delete');
        f.reader!.exec('BEGIN');
        assert.equal(snapshot(f.reader!), f.before);
        f.arm();
        const failed = caught(() => f.remove('group'));
        assert.equal(failed.threw, true);
        assert.equal(f.notifications.length, 0);
        assert.equal(snapshot(f.reader!), f.before);
        assert.equal(f.db.isTransaction, false);
        f.reader!.exec('COMMIT');
        assert.equal(snapshot(f.db), f.before);
        assert.equal(caught(() => f.remove('group')).threw, false);
        assert.equal(snapshot(f.reader!), f.expected('group'));
        assert.equal(f.notifications.length, 1);
    }
    finally {
        await f.close();
    } });
    for (const mode of ['keep-prior-unit', 'rollback-after-notify'])
        await check('nested/' + mode, async () => { const f = fixture(); try {
            f.db.exec('BEGIN');
            f.db.prepare('UPDATE monitor_objects SET name=? WHERE id=?').run('outer-kept', f.keep.id);
            f.arm();
            f.cfg.deleteRegister(f.points[0].id);
            const afterFirst = snapshot(f.db);
            assert.equal(f.notifications.length, 1);
            if (mode === 'keep-prior-unit') {
                f.db.exec(`CREATE TRIGGER synthetic_group_fail BEFORE DELETE ON register_groups WHEN OLD.id=${f.g.id} BEGIN SELECT RAISE(ABORT,'synthetic group failure'); END`);
                assert.equal(caught(() => f.remove('group')).threw, true);
                assert.equal(snapshot(f.db), afterFirst);
                assert.equal(f.db.isTransaction, true);
                assert.equal(f.notifications.length, 1);
                f.db.exec('COMMIT');
                assert.equal(snapshot(f.db), afterFirst);
            }
            else {
                f.failNotify();
                const failed = caught(() => f.remove('group'));
                assert.equal(failed.error, f.notifyFailure);
                assert.equal(f.db.isTransaction, true);
                assert.equal(f.notifications.length, 2);
                assert(f.notifications.every(event => event.transaction));
                f.db.exec('ROLLBACK');
                assert.equal(snapshot(f.db), f.before);
            }
        }
        finally {
            await f.close();
        } });
    for (const english of [false, true])
        for (const mode of ['lost-response', 'notification-failure', 'sql-failure', 'rejected', 'refresh-failed', 'cancel', 'busy'])
            await check('group-ui/' + english + '/' + mode, async () => {
                const f = fixture(), api = apiFor(f, 'group'), wait = gate();
                let requests = 0, refreshes = 0;
                try {
                    if (mode === 'sql-failure')
                        f.failPoint();
                    if (mode === 'notification-failure')
                        f.failNotify();
                    f.arm();
                    const send = async (url: string) => { requests++; if (mode === 'busy')
                        await wait.promise; if (mode === 'rejected')
                        throw Error('HTTP 409 synthetic rejected'); const response = await api.app.inject({ method: 'DELETE', url }); if (response.statusCode >= 400)
                        throw Error('HTTP ' + response.statusCode + ' ' + response.json().message); if (mode === 'lost-response')
                        throw TypeError('synthetic response lost'); return response.json(); };
                    const ui = groupUi(english, send, () => { refreshes++; if (mode === 'refresh-failed')
                        throw Error('synthetic refresh failure'); }, f.cfg.listGroups(f.d.id), mode !== 'cancel');
                    const work = ui.remove(f.g.id);
                    if (mode === 'busy') {
                        await tick();
                        await ui.remove(f.g.id);
                        assert.equal(requests, 1);
                        wait.resolve();
                    }
                    await work;
                    await tick();
                    assert.equal(requests, mode === 'cancel' ? 0 : 1);
                    if (mode === 'cancel') {
                        assert.equal(ui.notices.length, 0);
                        assert.equal(snapshot(f.db), f.before);
                    }
                    else if (mode === 'rejected') {
                        assert(ui.notices.at(-1)?.text.includes('409'));
                        assert.equal(snapshot(f.db), f.before);
                        assert.equal(refreshes, 0);
                    }
                    else if (mode === 'busy') {
                        assert.equal(ui.notices.at(-1)?.error, false);
                        assert.equal(refreshes, 1);
                        assert.equal(snapshot(f.db), f.expected('group'));
                    }
                    else {
                        const notice = ui.notices.at(-1)!;
                        assert.equal(notice.error, true);
                        if (mode === 'refresh-failed') {
                            assert(notice.text.includes(english ? 'returned success' : '返回成功'), 'refresh failure must not describe the committed deletion as failed');
                            assert.equal(refreshes, 1);
                        }
                        else {
                            assert(notice.text.includes(english ? 'unverified' : '待核实'), 'lost/failed response must state an unverified deletion outcome');
                            assert.equal(refreshes, 0);
                        }
                        assert(!notice.text.includes(english ? 'Operation failed' : '操作失败'), 'an uncertain or successful deletion must not show a generic operation-failed prefix');
                        assert.equal(snapshot(f.db), mode === 'sql-failure' ? f.before : f.expected('group'));
                    }
                }
                finally {
                    wait.resolve();
                    await api.app.close();
                    await f.close();
                }
            });
    for (const english of [false, true])
        for (const mode of ['lost-response', 'notification-failure', 'sql-failure', 'refresh-failed', 'refresh-conflict'])
            await check('device-ui/' + english + '/' + mode, async () => {
                const f = fixture(), api = apiFor(f, 'device'), page = draftSurface({ english }), modal = draftEditor('device', page.registration());
                let requests = 0, refreshes = 0;
                try {
                    modal.change('UNSAVED REVIEW');
                    page.setAnswer(true);
                    if (mode === 'notification-failure')
                        f.failNotify();
                    if (mode === 'sql-failure')
                        f.failPoint();
                    f.arm();
                    await page.deleteDevice(f.d.id, async (url) => { requests++; const response = await api.app.inject({ method: 'DELETE', url }); if (response.statusCode >= 400)
                        throw Error('HTTP ' + response.statusCode + ' ' + response.json().message); if (mode === 'lost-response')
                        throw TypeError('synthetic response lost'); return response.json(); }, () => { refreshes++; if (mode === 'refresh-failed')
                        throw Error('synthetic refresh failed'); if (mode === 'refresh-conflict')
                        throw Error('HTTP 409 synthetic refresh rejected'); });
                    await tick();
                    assert.equal(requests, 1);
                    assert.equal(page.drafts.retained().length, 1);
                    modal.submit();
                    assert.equal(modal.calls.save, 0);
                    const notice = page.notices.at(-1)!;
                    assert.equal(notice.error, true);
                    if (mode.startsWith('refresh')) {
                        assert(notice.text.includes(english ? 'returned success' : '返回成功'), 'a refresh HTTP error after DELETE success is not a rejected deletion');
                        assert.equal(refreshes, 1);
                        assert.equal(page.state().selectedId, null);
                    }
                    else {
                        assert(notice.text.includes(english ? 'unverified' : '待核实'));
                        assert.equal(refreshes, 0);
                        assert.equal(page.state().selectedId, f.d.id);
                    }
                    assert.equal(snapshot(f.db), mode === 'sql-failure' ? f.before : f.expected('device'));
                }
                finally {
                    modal.driver.dispose();
                    await api.app.close();
                    await f.close();
                }
            });
    await tick();
    assert.deepEqual(unhandled, []);
    assert.deepEqual(denied, []);
    assert.deepEqual(failures, []);
}
finally {
    net.Server.prototype.listen = listen;
    net.Socket.prototype.connect = connect;
    globalThis.fetch = fetch;
    process.off('unhandledRejection', onUnhandled);
}
console.log('DELETE COMPOSITION TEST OK: ' + passed.length + ' isolated two-connection/nested/notification and actual UI callback/API cases; no automatic retry, real browser, sockets, user data or devices');
