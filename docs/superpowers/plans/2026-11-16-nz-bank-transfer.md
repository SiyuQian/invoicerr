# New Zealand Bank Transfer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking. 本计划默认由一个 Agent 顺序执行；只有用户明确要求委派时才采用子 Agent 方式。

**Goal:** 支持配置、校验、保存和展示新西兰本地银行转账资料，覆盖设置页、客户限制、发票 PDF 和邮件，并保持现有 IBAN 功能兼容。

**Architecture:** 在现有注册表新增 `bank_transfer_nz`，使用现有配置 JSON 和文本字段渲染。通过一个可选的描述符校验回调补足后端格式校验；前端在支付方式表单层镜像校验，不改造通用 DocumentField 系统。复用现有付款资料输出，不接入银行支付服务。

**Tech Stack:** TypeScript、NestJS、Prisma/PostgreSQL、React、react-hook-form、Zod、Vitest、Cypress；沿用仓库 Node `>=26 <27` 和 npm。

**Spec:** `docs/superpowers/specs/2026-11-16-nz-bank-transfer-design.md`，执行前必须完整阅读。

## Global Constraints

- 实施授权：用户已于 2026-11-16 确认按本计划执行；本次交付包括实现、测试、文档和本地提交。
- ID：`bank_transfer_nz`；标签：`Bank transfer (New Zealand)`；放在现有 `bank_transfer` 后。
- 字段：`accountName` 必填、`accountNumber` 必填、`bankName` 选填；全部 `kind: 'text'`。
- 账户名/非空银行名：单行，trim 后非空，最长 200 字符。
- 账号：2-4-7-2 或 2-4-7-3；接受连字符四段、ASCII 空格四段、15/16 位连续数字，允许首尾 ASCII 空格；原样保存。
- 前导零和两/三位后缀完整保留；不得将账号转换为数字或删除任意非数字字符来修复输入。
- 无银行白名单、校验和算法、账户真实性/归属验证、银行 API、新二维码或新付款状态。
- 不新增依赖、数据库列、迁移、账号目录或国家自动开关。
- 不修改旧 `bank_transfer` ID；不向 `Company.iban/bic` 写 NZ 资料；不自动转换旧账号或客户限制。
- 后端是校验权威；保留现有 disabled draft、权限、租户过滤和客户端允许列表语义。
- 写入沿用 OWNER/ADMIN + `company:write`，读取沿用 `company:read`，所有配置查询按 companyId 约束。
- 错误不回显账号；测试使用虚构账号，不读取或展示生产客户收款资料。

## Review Focus

1. 两/三位后缀与前导零：原样往返；Task 1 的数据表测试及 Task 5 的真实刷新测试负责。
2. 直接 API 与启用开关绕过 UI：无效写入在落库前拒绝；Task 1 的 persistence 测试及 Task 5 API 测试负责。
3. 已有客户只允许 `bank_transfer`：不能隐式获得新方式；Task 4 的客户端限制测试负责。
4. 已保存 IBAN 与欧洲专用消费者：新资料不得覆盖或混入它们；Task 1 和 Task 4 的兼容测试负责。
5. 带 HTML 字符的收款名称与日志：文档转义且日志脱敏；Task 3 和 Task 4 的测试负责。

## 文件地图

下列路径以仓库根为基准。未列为修改的消费者也需要阅读，但没有失败证据时不重写。

| 责任 | 新增/修改文件 |
| --- | --- |
| NZ 描述符和校验 | 新增 `backend/src/modules/documents/payment-methods/nz-bank-transfer.descriptor.ts` 及同名 `.spec.ts` |
| 注册和共享校验 | 修改 `backend/src/modules/documents/payment-methods/{types.ts,built-in.ts,persistence.ts}`；扩展该目录 `built-in.spec.ts`、`persistence.spec.ts`、必要时 `payment-methods.controller.spec.ts` |
| 前端支付表单校验 | 新增 `frontend/src/pages/(app)/payment-methods/_components/payment-method-config-schema.ts` 及 `.spec.ts`；修改同目录 `payment-method-config-dialog.tsx`；新增同目录 `payment-method-config-dialog.spec.tsx` |
| 前端文案 | 按现有 i18n 检查规则更新 `frontend/src/locales/en/translation.json` 和 `frontend/src/locales/fr/translation.json`；其他实际要求同步的目录由 `i18n:check` 确认 |
| 日志脱敏 | 修改 `backend/src/logger/redaction.ts`、`backend/src/logger/redaction.spec.ts` |
| 输出和客户限制回归 | 扩展 `backend/src/modules/documents/payment-methods/{persistence.spec.ts,email-block.spec.ts}` 和 `backend/src/modules/documents/rendering/{render-html.spec.ts,render-instance-pdf.spec.ts}`；按测试隔离需要扩展 `actions/send-document-email.spec.ts` |
| 浏览器验收 | 修改 `e2e/cypress/e2e/61-payment-methods.cy.ts`、`116-client-payment-method-restriction.cy.ts`，复用现有 PDF/邮件测试工具 |
| 用户文档 | 修改 `documentation/docs/user-guide/billing/payment-methods.md` |

读取但默认不修改：`frontend/src/hooks/queries/use-payment-methods.ts`、`frontend/src/types/payment-method.ts`、`frontend/src/pages/(app)/clients/_components/client-payment-methods.tsx`、`backend/prisma/schema.prisma`、`frontend/src/pages/(app)/settings/_components/company.settings.tsx`、`backend/src/modules/documents/{formats/party-snapshot.ts,formats/semantic/build-semantic-invoice.ts,transports/invopop/gobl-invoice.ts,transports/chorus-pro-transport.ts,rendering/sepa-qr.ts}`。检查 `invoice.descriptor.ts` 中由注册表生成的 record-payment 选项，不另建选项来源。

## Task 0：准备并确认基线

**Files:** 上面的设计文档、文件地图、仓库当前适用的 `AGENTS.md`、`documentation/docs/developer-guide/local-development.md`。

- [x] 读取上述文件与 `git status --short`。当前会话已经在独立工作树中，执行时重新确认，避免重复创建工作树或覆盖他人编辑。
- [x] 记录基线提交、Node/npm 版本、测试数据库与服务启动方式。依赖已安装时不重装；不得读取或打印凭据。
- [x] 在 backend 运行 `npm test -- src/modules/documents/payment-methods`，在 frontend 运行 `npm test -- 'src/pages/(app)/payment-methods'`；记录已存在的失败。预期退出码 0；若环境缺失，按实际错误修复测试环境，不把未运行记作通过。

## Task 1：实现 NZ 描述符、后端校验和存储契约

**Files:** 文件地图中的 backend 描述符、注册、共享校验及对应测试。

**Interfaces:**

- 消费：`validateAgainstDescriptor(fields, config, fieldKindRegistry): ValidationError[]`、`presentFromFields(descriptor, config)` 和既有 `CompanyPaymentMethodConfig`。
- 新增可选接口：`PaymentMethodDescriptor.validateConfig?(config: Record<string, unknown>): ValidationError[]`，`ValidationError` 复用 `descriptors/validate.ts`；不改变 `present` 契约。
- 新增导出：`nzBankTransferPaymentMethod: PaymentMethodDescriptor`、`validateNzBankTransferConfig(config: Record<string, unknown>): ValidationError[]`，放在同一 NZ 描述符文件，不拆成通用银行框架。
- 既有私有 `validationErrorsFor(method, config)` 合并结构与回调错误。API `fields` 仍只返回数据，不序列化回调。

- [x] **先写失败测试：账号和字段校验。** 在新描述符测试中表驱动覆盖以下输入；每例带合法 `accountName`，除非专门测试该字段。

| 输入 | 结果 |
| --- | --- |
| `12-3456-0123456-00`、`12-3456-0123456-000` | 有效；原样展示，后缀不改写 |
| `12 3456 0123456 00`、多 ASCII 空格分段、首尾 ASCII 空格 | 有效；原样保留 |
| `123456012345600`、`1234560123456000` | 有效；仍为字符串 |
| `12-3456-0123456-0`、`12-3456-0123456-0000`、缺一段、主体六位 | 无效 |
| `12/3456/0123456/00`、混合空格/连字符、字母、全角数字、制表符、换行、科学计数法 | 无效 |
| 数字类型、null、数组、对象作为 accountNumber | 结构校验拒绝，不强制字符串转换 |
| 缺失/空串/纯空白 accountName、201 字符、含换行 | 无效 |
| 不填 bankName、合法 Unicode 账户名（含 Māori 字母）、合法银行名 | 有效；空银行名不输出 |
| 非空 bankName 为纯空白、201 字符或含换行 | 无效；不影响空串可省略的规则 |

- [x] **先写失败测试：持久化、启用和兼容。** 扩展 `persistence.spec.ts`：新方式默认关闭/未配置；合法 config 经 JSON 写入且刷新相同；开启时缺字段/格式错误返回 400，所有写 mock 未调用；裸 toggle 重验现有 config；disabled draft 可保存但 `configured=false`；关闭后字段保留；显式 config 为 null/数组/标量返回 400；省略 config 的 toggle 不覆盖值。预置 IBAN/BIC 后保存 NZ 配置，断言 `prisma.company.update` 未调用，旧 `bank_transfer` 的 config 不变。沿用并补足 companyId 查询断言。
- [x] 运行 `npm test -- src/modules/documents/payment-methods`（backend）。预期新用例失败，失败原因为功能缺失；记录结果。
- [x] **实现最小改动。** 新增描述符，`present()` 复用 `presentFromFields`；注册到固定位置；实现可选校验回调并接入唯一共享校验入口；在持久化前检查显式 config 为非 null、非数组对象。回调只检查已提供字符串的业务格式，结构校验继续负责缺失和类型；禁止输出包含账号的错误。保持原六种方式的行为及禁用草稿语义。
- [x] 将 `built-in.spec.ts` 的精确六项断言改为七项，保留顺序、唯一 ID 和旧方式断言；检查 registry 和 mock fixtures，不删除老测试来迁就新方式。
- [x] 再运行 Task 1 测试，预期全部 PASS。检查既有权限测试；使用新 ID 参数化一个 OWNER/ADMIN 可写、普通成员/缺 scope 不可写的真实控制器测试，沿用现有测试方法。
- [x] 仅提交本任务文件：`feat: add New Zealand bank transfer configuration`。

## Task 2：接通表单校验和可用界面

**Files:** 文件地图中的前端 schema helper、配置对话框、测试和翻译。

**Interfaces:**

- 消费：Task 1 返回的新 `PaymentMethodConfig`，其字段仍为普通 text；既有 `buildZodSchema(method.fields)` 和 `defaultValuesFor`。
- 新增：`buildPaymentMethodConfigSchema(method: Pick<PaymentMethodConfig, 'id' | 'fields'>, t: TFunction): z.ZodType<Record<string, unknown>>`。先建立原 schema，仅 `id === 'bank_transfer_nz'` 时附加字段校验，错误路径为 `accountName` / `accountNumber` / `bankName`。
- 本层不改账号内容；提交仍为现有 `{methodId, config, enabled?}`。

- [x] 在新 schema 测试中镜像 Task 1 输入表，并断言错误 field path；原六种方式 schema 行为保持一致。两端用例必须相同，不创建跨包构建系统来共享一个正则。
- [x] 在新 dialog 测试中使用真实文本字段渲染器、mock 查询 mutation：NZ 表单没有 IBAN/BIC；无效账号显示可读的字段错误且不发请求；合法三位后缀原样发出；switch 打开时发送 `enabled:true`；Configure 打开时不擅自启用；重开使用当前 server config；请求失败时保留编辑内容和弹窗。
- [x] 运行 `npm test -- 'src/pages/(app)/payment-methods'`（frontend），确认新增用例先失败。
- [x] 实现 helper 并替换对话框的 schema 构建，保留现有 reset、激活和错误处理。错误文案加入 `paymentMethods.nzBankTransfer.errors.{accountName,accountNumber,bankName}`，通过 `t` 获取；账号错误应说明两种后缀宽度。描述符 `helpText` 给出 `BB-BBBB-AAAAAAA-SS or BB-BBBB-AAAAAAA-SSS` 示例。
- [x] 沿用现有文本 input、label、FormMessage 和 data-cy，不换成 number input，不增加银行下拉框，不改造通用字段类型。
- [x] 重跑本任务测试，再运行 frontend `npm run i18n:check`、`npm run build`。预期全部退出码 0；按现有翻译检查要求同步必要目录，不批量重写翻译。
- [x] 提交：`feat: validate New Zealand bank details in payment settings`。

## Task 3：补齐新收款字段的日志脱敏

**Files:** `backend/src/logger/redaction.ts`、`backend/src/logger/redaction.spec.ts`。

**Interfaces:** 复用现有 redaction 导出和敏感键规范化逻辑，不新增日志设施。

- [x] 先写测试：`config.accountNumber`、`bankAccountNumber`、`accountName` 在嵌套对象和数组内均为既有 `REDACTED`；normalized key 变体（如下划线/大写）也被处理；`companyId`、`methodId`、错误码保持可诊断。
- [x] backend 运行 `npm test -- src/logger/redaction.spec.ts`，确认新测试先失败。
- [x] 向现有敏感键集合加入 `accountnumber`、`bankaccountnumber`、`accountname`；避免记录账号自由文本，不新增全局数字匹配正则。
- [x] 重跑同一测试，预期 PASS；提交：`fix: redact bank account details from structured logs`。

## Task 4：验证输出链路、客户限制和旧功能

**Files:** 文件地图中的输出/限制测试；只有发现未接通的消费者时才修改对应运行时代码。

**Interfaces:** 消费 Task 1 的 `bank_transfer_nz`、现有 `resolveEnabledPaymentMethodPresentations(companyId, ctx?, clientId?)` 及 `PaymentMethodPresentation`；不引入第二个输出来源。

- [x] 扩展 persistence 测试：公司开启且客户 unrestricted → 输出 NZ；客户只允许 `bank_transfer` → 不输出 NZ；客户显式允许 NZ → 输出；公司关闭 → 即使客户允许也不输出；外租户 clientId 不能被设置限制。允许列表对新旧银行方式分别处理。
- [x] 扩展 `render-html.spec.ts` 和 `email-block.spec.ts`：Account name/Account number/可选 Bank name 正确输出；没有 IBAN 标签或新支付链接；含 `<`、`&`、引号的合法账户名经过既有 HTML 转义。检查纯文本邮件仍有同一账号。
- [x] 扩展 `render-instance-pdf.spec.ts` 的 `paymentMethodsFor` 用例验证实际依赖新配置；避免只 mock 出一个手写 NZ presentation 来宣称端到端通过。Task 5 再覆盖真实生成 PDF。
- [x] 运行 backend `npm test -- src/modules/documents/payment-methods src/modules/documents/rendering/render-html.spec.ts src/modules/documents/rendering/render-instance-pdf.spec.ts src/modules/documents/actions/send-document-email.spec.ts`。新增消费者测试可直接通过；若失败，先追踪原因再做最小修复。
- [x] 增加隔离断言：旧 IBAN 存在且配置 NZ 时，`party-snapshot` 仍读取旧 IBAN；NZ-only 且 `Company.iban=null` 时不产生 SEPA QR、不把本地账号写成 `seller.iban`。确认新方式成为 record-payment 合法选项且登记金额/币种算法不变。
- [x] 运行兼容测试：backend `npm test -- src/modules/documents/formats/party-snapshot.spec.ts src/modules/documents/formats/xrechnung-provider.spec.ts src/modules/documents/rendering/sepa-qr.spec.ts src/modules/documents/transports/chorus-pro-transport.spec.ts src/modules/documents/settlement`。如当前测试文件名发生变化，执行前用 `rg --files` 找到对应文件，不默默跳过。
- [x] 确认 Chorus Pro 继续具名拒绝其不支持的方式，不能把新 ID 加进 IBAN 专用映射来“让测试通过”；其他旧在线支付方式不修改。
- [x] 提交：`test: cover New Zealand bank transfer presentation and compatibility`。

## Task 5：浏览器验收、文档和交付证据

**Files:** `e2e/cypress/e2e/61-payment-methods.cy.ts`、`116-client-payment-method-restriction.cy.ts`、`documentation/docs/user-guide/billing/payment-methods.md`。

**Interfaces:** 使用真实 GET/PATCH payment-methods API 和既有单据生成/邮件捕获工具；不向银行发送请求，不向真实客户发送邮件。

- [x] 为新方式加入真实 API 往返：GET 默认关闭；PATCH 合法资料启用；GET 保持前导零及后缀；PATCH 已启用方式为无效账号返回 400，GET 与先前值完全相同；disabled → re-enable 资料保留。测试新 ID 的权限和租户隔离时复用项目已有认证 fixture。
- [x] 加入浏览器流程：打开新配置框 → 输入合法 NZ 资料 → Save → 刷新 → 重开确认值；错误输入被字段错误阻止；旧 IBAN 方式仍可配置。保留原方式的断言，显式增加 NZ 行，不盲目把六改七。
- [x] 用 NZD 发票生成实际 PDF，提取文本或检查渲染产物，断言完整账号及 Account number 标签；通过测试邮件捕获器检查同一张发票邮件的 HTML/文本。不得只检查 API presentation 代替真实 PDF/邮件验收。
- [x] 在 `116-client-payment-method-restriction.cy.ts` 覆盖“只允许旧 bank_transfer 不显示新方式”及“显式允许新方式后显示”，再验证公司禁用的优先级。
- [x] 更新用户文档：七种方式、两个银行入口区别、字段和输入示例、只做格式校验、不自动确认到账；现有客户限制需显式允许 NZ；先前误填 IBAN 的用户人工核对重配，不自动迁移；删除“只有六行”等过时描述。
- [x] backend 运行 `npm run build`；frontend 运行 `npm run build` 和 `npm run i18n:check`；e2e 运行 `npm run typecheck`。对改动文件使用该包已安装 Biome 执行检查，不顺手格式化其他文件。
- [x] 提交以上实现和验收测试后再从该提交启动冻结的本地测试 checkout；确认其 HEAD 含所有改动。现有 `scripts/e2e-worktree.sh` 会强制移除它指定的工作树，不能盲用默认目录，先核查归属，使用本次独占的 `E2E_WORKTREE`、`E2E_DB`，并按本机文档确认测试服务/端口。
- [x] 本地隔离测试环境已按文档启动时，可在 e2e 目录运行 `npx cypress run --browser firefox --spec 'cypress/e2e/61-payment-methods.cy.ts,cypress/e2e/116-client-payment-method-restriction.cy.ts,cypress/e2e/48-payment-qr.cy.ts,cypress/e2e/24-document-payments.cy.ts'`。冻结工作树脚本方式则传入相同 `--spec`；只选一种方式，不重复跑两套。
- [x] 记录真实 PDF/邮件证据及测试结果；若缺少数据库、浏览器或邮件捕获器，列出缺失环境和未执行用例，不把任务标为已验收。不调用生产服务代替测试环境。
- [x] 提交：`test: verify NZ bank transfers end to end and document setup`。

## 完成门槛与交付格式

执行 Agent 交付时逐项给出证据，不能仅说“支持 NZ 了”：

- [x] 设计文档 7 条验收标准均对应通过的用例或人工产物。
- [x] 三种输入样式、两种后缀宽度、前导零、失败无写入、租户/权限和客户限制均有测试证据。
- [x] 至少一个真实 NZD 发票 PDF 和一封测试邮件含完整 NZ 资料，且没有误用 IBAN 标签。
- [x] 旧 IBAN 配置、SEPA/电子发票相关测试和收款金额/状态测试保持通过。
- [x] `git diff --check` 无错误；列出最终改动、提交、运行命令和结果、未执行项目及原因。
- [x] 不自动部署或替用户修改生产收款账户；交付可审阅实现。

## 上线与回退说明

- 没有 schema migration；新方式默认关闭，新版本上线不会主动改变任何收款账户或客户允许列表。
- 支持标准 NZ 本地账户格式；BNZ 等银行的特殊外币账户格式及国际电汇资料不在本期范围，用户文档必须明确这一点。
- 前后端同版本发布，避免新后端返回新方式但旧 UI 缺少前端格式提示；后端校验始终生效。
- 试用时由管理员核对账户资料并启用，生成一份测试发票检查完整账号，再向需要的客户显式允许新方式。
- 回退旧版本前先关闭新方式，并检查仅允许 NZ 的客户是否需要改成其他已配置方式。旧版本忽略未知方式可能使这些客户看不到任何付款指引，不能静默扩大其允许列表。
- 保留 JSON 配置和历史付款记录，不执行清理 SQL；已发送 PDF/邮件是历史产物，回退不会改写它们。

## 执行入口（可直接复制给 Agent）

> 阅读 `docs/superpowers/specs/2026-11-16-nz-bank-transfer-design.md` 和 `docs/superpowers/plans/2026-11-16-nz-bank-transfer.md`，按 Task 0–5 顺序实现并逐项更新复选框。采用新 `bank_transfer_nz` 描述符方案，复用现有注册、JSON 配置、文本表单和输出链路。先写失败测试，再实现；不新增依赖、迁移或银行 API，不把 NZ 账号写入 IBAN 列，不修改生产收款资料。完成后按“完成门槛与交付格式”报告验证证据和遗漏。执行过程中若发现设计与现有代码冲突，先给出具体代码证据，再提出最小调整。


## 执行结果（2026-11-16）

- Task 0–5 已完成。新增 NZ 方式、后端格式校验、表单字段错误、日志脱敏和用户说明；无数据库迁移或新增产品依赖。
- 后端付款配置和脱敏：10 个文件、144 项通过。输出、客户限制、SEPA、XRechnung、Chorus Pro 与金额结算：24 个文件、400 项通过。两组后端测试存在重叠，合计不相加。
- 前端付款方式：3 个文件、44 项通过；backend/frontend 构建、frontend i18n、e2e TypeScript 检查及改动 TS 文件 Biome 检查通过（E2E 保留原文件排版）；locale JSON 按仓库配置不由 Biome 处理，已通过 JSON 解析和 i18n 检查。
- 浏览器验收：61（7 项）、116（2 项）、48（3 项）、24（6 项）均通过，共 18 项；61 的最终通过记录包含真实 NZD 发票 PDF、HTML/纯文本邮件、刷新往返、无效 API 写入不覆盖、未自动到账及手动登记 1 NZD = 100 分。
- 独立代码审查：无 Critical/Important；已修复迁移说明，明确误填在 IBAN 中的本地账号需人工核对后从公司设置清除，合法 IBAN 保留。
- PDF 已渲染为 PNG 检查；付款资料没有遮挡或账号截断。测试 PDF、邮件 JSON、截图及运行日志保存在本线程存储的 `nz-bank-transfer/` 下。
- 执行调整：保留 Zod schema 推导类型以兼容 resolver；仅 NZ 表单补空字符串校验；Firefox 缺失时使用 Chromium；使用不带 watch 的编译后服务器代替会强制移除工作树的脚本。
- 测试资料调整：默认法国公司缺少 NZD 的测试 ECB 汇率；NZD 邮件验收改用 NZ 非 GST 注册测试公司，未修改生产 FX/税务代码。发送和登记收款请求沿用 API 要求，提交已保存的完整单据 data。
- 代码保留在当前 BB 工作树分支，已本地提交；未推送、合并或部署。未跑全部仓库测试，只运行上述与变更相关的检查；不验证银行账号真实性或发起真实汇款。
