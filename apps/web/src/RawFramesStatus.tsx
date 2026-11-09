import React from 'react'
import type { RawFramesState } from './raw-frames-read'
export function RawFramesStatus({ state, paused, english = false, exceptionFocus, sharedSerial = false }: { state: RawFramesState; paused: boolean; english?: boolean; sharedSerial?: boolean; exceptionFocus?: { active: boolean; shown: number; change: (active: boolean) => void } }) {
  const text = (zh: string, en: string) => english ? en : zh, value = state.value
  return <div className="raw-frames-status">
    <p className="chart-hint diagnostic-source-note">{text('后台报告未绑定本页配置版本；通知可能延迟或遗漏，需核对来源。', 'Reports are not bound to this page’s config version; delayed/missed updates require source checks.')}</p>
    {sharedSerial && <p className="chart-hint">{text('共享RTU通道：按后台当前配置的从站字节筛选有限捕获，不能认定属于当前设备。', 'Shared RTU channel: captures filtered by configured slave bytes are not exclusive to this device.')}</p>}
    <p className="chart-hint">{text('原始捕获时间，非设备时钟；未标时区则不推断。TX=后台发送，RX=后台接收，不保证有效响应。', 'Original capture time, not device clock; missing zone stays unknown. TX=backend sent; RX=backend received, not a verified response.')}</p>
    {state.phase === 'loading' && <p role="status">{text('正在读取后台捕获记录；慢请求期间不会叠加新读取。', 'Reading backend captures; slow reads do not overlap.')}</p>}
    {state.phase === 'error' && <p role="alert">{text(state.error === 'timeout' ? '读取超过10秒，将允许下一轮恢复。' : state.error === 'invalid' ? '捕获记录或来源无法核实。' : '捕获记录读取失败。', state.error === 'timeout' ? 'Read exceeded 10 seconds; subsequent refreshes can recover.' : state.error === 'invalid' ? 'Capture records or source could not be verified.' : 'Capture read failed.')}{text(' 当前后台状态未核实。', ' Current backend state is unverified.')}{value && text(' 保留上次显示，旧记录不代表仍在通信。', ' Previous captures remain visible and do not establish ongoing communication.')}</p>}
    {paused && <p role="status">{text('仅暂停页面读取，设备采集继续；在途旧响应不会改动当前显示。', 'Only page reads are paused; acquisition continues. Late responses cannot change this display.')}</p>}
    {value && <p>{text('显示快照接收于UTC', 'Displayed snapshot received at UTC')}: {value.receivedAt} · {value.frames.length}/{value.limit} {text('条；仅后台有限缓冲，不是完整通信历史。', 'captures; bounded backend buffer, not a full communication history.')}{value.frames.length === value.limit && text(' 达到显示上限，可能还有更早记录。', ' Display limit reached; earlier captures may exist.')}</p>}
    {value && exceptionFocus && <><div className="toolbar"><label><input type="checkbox" checked={exceptionFocus.active} onChange={event => exceptionFocus.change(event.target.checked)} />{text('仅看已标记异常捕获', 'Only marked exceptions')}</label><span>{text('显示', 'Showing')} {exceptionFocus.shown}/{value.frames.length}</span>{exceptionFocus.active && <button className="btn" type="button" onClick={() => exceptionFocus.change(false)}>{text('显示全部', 'Show all')}</button>}</div>
      {exceptionFocus.active && <p className="chart-hint">{text('仅按isException标记筛选；超时/连接错误可能没有对应异常捕获。', 'Filters isException markers only; timeouts/connection errors may have no matching capture.')}</p>}
      {exceptionFocus.active && value.frames.length > 0 && exceptionFocus.shown === 0 && <p role="status">{text('当前快照未匹配；不等于没有通信错误。', 'No matches in this snapshot; this does not mean no communication errors.')}</p>}
    </>}
    {value?.frames.some(frame => !frame.sourceMetadataMatched) && <p>{text('部分旧记录缺少完整来源元数据，保留可查看能力，但不视为来源已核实。', 'Some legacy captures lack complete source metadata; they remain viewable without verified origin.')}</p>}
    {state.phase === 'ready' && !value?.frames.length && <p role="status">{text('本次读取没有返回捕获记录；不据此判断设备未通信或通信正常。', 'This read returned no captures; it does not establish silence or healthy communication.')}</p>}
    {!value && state.phase === 'idle' && <p role="status">{text('尚未读取捕获记录。', 'No captures have been read yet.')}</p>}
    <p className="chart-hint">{text('记录可能是TCP/串口字节块，显示的从站/功能码是捕获时的字节解释，不证明完整帧或物理来源。', 'Captures may be TCP/serial byte chunks. Displayed slave/function fields are byte interpretations, not proof of a complete frame or physical origin.')}</p>
  </div>
}
