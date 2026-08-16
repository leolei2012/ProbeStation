# 语义清单契约（YAML 规范）

> 状态：v1.2 · 日期：2026-08-14
> 读者：**固件开发 agent**（写单片机程序的一方）——它产出本文件，供**调试 agent 自己看**。
> 定位：本文是「寄存器说明书」的格式规范。**YAML 是唯一真源，Excel 是导出视图。**
> 语义清单是给**调试 agent 看的参考文档**：agent 拿它理解原始数据。**平台不消费本文件。**

---

## 1. 这是什么、为什么需要它

固件开发 agent 写完单片机程序、在 Modbus 上挂了寄存器之后，调试 agent 读到的是一堆**没有含义的裸数字**（如 `254`、`171`），不知道：

- 这是温度还是故障码？
- 要不要 ×0.1？
- 是停机还是运行？

**语义清单**就是解决这个断层：它把每个寄存器的「名称 / 地址 / 类型 / 缩放 / 单位 / 枚举 / 位域」用 YAML 记录下来，**给调试 agent 当说明书**——agent 读到原始值后，对照这份 YAML 自己理解「这是什么量、值是多少、单位是什么」。

**核心原则：语义跟着固件走。** 固件开发 agent 写完寄存器，就顺手产出这份 YAML，与固件一起版本化提交。**这份 YAML 是 agent 之间的参考文档，平台不解析它。**

---

## 2. 谁产出、谁消费、谁维护

| 角色 | 动作 |
|---|---|
| 固件开发 agent | **产出** YAML（唯一真源），随固件一起提交 |
| 平台（ProbeStation） | **不消费** YAML：只提供原始数据读写（读/写 Modbus 原始值） |
| 调试 agent | **使用**语义 + MCP 工具读写设备 |
| 固件工程师（人） | 用 **Excel 视图**审阅、补描述（可选回写 YAML） |

**唯一真源规则**：

- **YAML 是唯一真源**，git 版本化。
- **Excel 是从 YAML 导出的视图**，给人看；人改的是 Excel，改完**回写 YAML**，不维护两份独立数据。
- 调试 agent 只认 YAML，不认 Excel。

---

## 3. 文件整体结构

```yaml
firmware:            # 顶层：固件与设备信息
  name: 雪融机控制器
  version: "1.2.3"   # 固件版本号（必填）
  description: 冰沙机主控板          # 可选
  device:            # 可选：绑定到平台已配的设备
    name: 雪融机
    ip: 192.168.90.32
    port: 8899
    unit_id: 1

registers:           # 寄存器语义清单（数组）
  - name: motor_temp
    # ... 见 §4 字段定义
```

---

## 4. 字段定义

### 4.1 顶层 `firmware`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | 是 | 固件/设备名 |
| `version` | string | 是 | 固件版本号。**调试前要能确认「这份清单 == 设备当前固件」**，防过期语义 |
| `description` | string | 否 | 一句话描述 |
| `device` | object | 否 | 绑定设备信息（`name` / `ip` / `port` / `unit_id`） |

### 4.2 寄存器 `registers[]`

#### 必填字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | 是 | **语义名**（唯一）。调试 agent 用它寻址（如 `read("motor_temp")`），不用数据库自增 id。命名用 snake_case 英文 |
| `address` | number | 是 | 寄存器起始地址。可写十进制或十六进制（`0x0064`） |
| `data_type` | string | 是 | 数据类型，见 §5 类型表 |

#### 可选字段

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `description` | string | — | 中文/英文描述 |
| `access` | string | `read` | `read` / `write` / `read_write`。**纯描述信息**（告诉 agent 这个寄存器只读还是可写），平台**不据此拦截** |
| `scale` | number | `1` | 缩放系数。**物理值 = 裸值 × scale** |
| `unit` | string | — | 单位（如 `℃`、`rpm`、`V`、`A`） |
| `enum` | object | — | 枚举含义表：`裸整数值 → 中文含义`。见 §6.2 |
| `bitfield` | array | — | 位域定义：一个寄存器拆成多个标志位。见 §6.3 |
| `volatile` | boolean | `false` | 自清零命令位：写后读回自动归零。见 §6.4 |

---

## 5. 数据类型 `data_type`

| 类型 | 含义 | 位数 |
|---|---|---|
| `int16` | 16 位有符号整数 | 16 |
| `uint16` | 16 位无符号整数 | 16 |
| `int32` / `uint32` | 32 位整数 | 32 |
| `float32` | 32 位浮点 | 32 |
| `int64` / `uint64` | 64 位整数 | 64 |
| `float64` | 64 位浮点 | 64 |

> 端序（大端/小端）：默认大端；需要小端时平台按字节/字序规则处理，语义清单**不需要**写端序（由平台与固件约定）。

---

## 6. 关键字段怎么填

### 6.1 `scale`（缩放）

物理值 = 裸值 × scale。

```yaml
- name: motor_temp
  address: 0x0064
  data_type: int16
  scale: 0.1     # 裸值 254 → 25.4
  unit: "℃"
```

> 注意方向：裸值 254、scale 0.1、物理值 25.4。**别写反**（写 10 会变成 2540）。

### 6.2 `enum`（枚举）

枚举状态通常是离散整数码，**不做缩放**。key 用**裸整数值**，value 是含义。

```yaml
- name: motor_state
  address: 0x0065
  data_type: uint16
  enum:
    0: 停机
    1: 运行
    2: 故障
```

### 6.3 `bitfield`（位域）

单片机常把 16 位一个格子拆成多个独立标志。用 `bitfield` 声明如何拆分。

- 单 bit：`{ bit: 0, name: enable, desc: 使能 }`
- 多 bit 字段：`{ bit: 2, width: 2, name: mode, enum: {0: 停机, 1: 运行, 2: 故障} }`

```yaml
- name: status_word
  address: 0x0066
  data_type: uint16
  bitfield:
    - { bit: 0, name: enable, desc: 使能 }
    - { bit: 1, name: direction, desc: 方向，0=正转 1=反转 }
    - { bit: 2, width: 2, name: mode, enum: { 0: 停机, 1: 运行, 2: 故障 } }
    - { bit: 15, name: fault_flag, desc: 故障标志 }
```

> 有了它，agent 才能看懂「裸数字 18 = 使能关 + 模式运行」，而不是一团乱码。

### 6.4 `volatile`（自清零命令位）

命令寄存器写一次执行一个动作，**读回自动归零**。标 `volatile: true`，调试 agent 才不会把「写完读回 0」误判成写失败。

```yaml
- name: start_cmd
  address: 0x0201
  data_type: uint16
  access: write
  volatile: true   # 写 1 启动，读回恒为 0，属正常
```

---

## 7. 完整示例（可照抄）

```yaml
firmware:
  name: 雪融机控制器
  version: "1.2.3"
  description: 冰沙机主控板
  device:
    name: 雪融机
    ip: 192.168.90.32
    port: 8899
    unit_id: 1

registers:
  - name: motor_temp
    description: 电机温度
    address: 0x0064
    data_type: int16
    scale: 0.1
    unit: "℃"
    access: read

  - name: motor_speed
    description: 电机转速
    address: 0x0065
    data_type: uint16
    unit: "rpm"
    access: read

  - name: motor_state
    description: 电机状态
    address: 0x0066
    data_type: uint16
    access: read
    enum:
      0: 停机
      1: 运行
      2: 故障

  - name: status_word
    description: 状态字
    address: 0x0067
    data_type: uint16
    access: read
    bitfield:
      - { bit: 0, name: enable, desc: 使能 }
      - { bit: 1, name: direction, desc: 方向，0=正转 1=反转 }
      - { bit: 2, width: 2, name: mode, enum: { 0: 停机, 1: 运行, 2: 故障 } }
      - { bit: 15, name: fault_flag, desc: 故障标志 }

  - name: heater_setpoint
    description: 加热设定温度
    address: 0x0100
    data_type: int16
    scale: 0.1
    unit: "℃"
    access: write

  - name: motor_enable
    description: 电机使能
    address: 0x0200
    data_type: uint16
    access: write

  - name: start_cmd
    description: 启动命令
    address: 0x0201
    data_type: uint16
    access: write
    volatile: true
```

---

## 8. Excel 导出视图

- 由 YAML **生成**（脚本），供固件工程师审阅，不做人工编辑的副本。
- 一行一个寄存器，列 = 字段（name / address / data_type / scale / unit / enum / bitfield / access / description）。
- 工程师在 Excel 里批注/改错后**回写 YAML**（脚本双向同步），YAML 始终是真源。

---

## 9. 版本与新鲜度（重要）

固件会迭代，寄存器表会变。**过期语义比没有语义更危险**（agent 会自信地看错）。

- `firmware.version` 必填，调试前 agent 应能核对「清单版本 == 设备当前固件」。
- 建议（可选）为 `registers` 生成**指纹**（如内容哈希），用于校验清单与固件是否一致。

---

## 10. 与平台（ProbeStation）的关系

| 层 | 职责 |
|---|---|
| 语义清单（本文件） | 描述「每个寄存器是什么」（给调试 agent 自己看的说明书） |
| 平台 | 只提供原始数据读写，不解析本文件 |
| MCP 工具 | 面向调试 agent 暴露「读/写原始数据」能力（详见后续 PRD） |

**本文件是 agent 之间的参考文档；平台不消费它。MCP 工具集细节在另一份《Agent 调试接口 PRD》中定义。**
