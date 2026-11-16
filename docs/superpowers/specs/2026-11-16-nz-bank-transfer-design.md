# 新西兰银行转账格式支持：设计约束

状态：已按用户确认的执行计划实现并验证；验证结果见执行计划末尾。

## 目标与范围

让公司能够配置新西兰本地银行收款资料，启用后向允许使用该方式的客户展示，并在既有发票 PDF、邮件等付款资料出口正确输出。客户照这些资料自行转账，财务沿用现有流程登记到账。

本期是收款资料格式支持，不接入银行 API、Open Banking、POLi、直接扣款、支付发起、自动到账确认、银行白名单或账户归属验证。不增加多个 NZ 账户、银行目录、自动识别银行、独立 Reference 配置或新的付款二维码。

## 已核查的事实

- `payment-methods/bank-transfer.descriptor.ts` 把 `iban` 定义为必填文本、`bic` 为选填文本；此处没有 IBAN 校验算法。
- `payment-methods/persistence.ts` 对现有 `bank_transfer` 单独桥接 `Company.iban/bic`，其他方式使用 `CompanyPaymentMethodConfig.config` JSON。
- 前端配置对话框按后端 `fields` 渲染，卡片按 `fields + config` 展示预览。
- `BUILT_IN_PAYMENT_METHODS` 同时驱动设置页和新收款记录的方式选项。
- PDF 与邮件使用既有 `PaymentMethodPresentation`；客户限制按精确 `methodId` 匹配。
- `Company.iban` 还被 SEPA QR、语义电子发票、XRechnung、Invopop 等读取；Chorus Pro 对支付方式有明确限制。
- 当前共享校验只有字段结构校验；新增 NZ 格式校验必须用于 `configured` 和启用写入这两个路径。

上面文件均位于 `backend/src/modules/documents/` 下，前端文件位于 `frontend/src/pages/(app)/payment-methods/`。

## 方案比较与建议

| 方案 | 收益 | 代价 | 决定 |
| --- | --- | --- | --- |
| 新增 `bank_transfer_nz` 描述符 | 复用现有注册、JSON 存储、UI、客户限制和输出机制；不触碰 IBAN 语义 | 页面多一行；已有客户限制需要显式允许新方式 | 本计划采用的建议方案 |
| 原 `bank_transfer` 增加格式切换 | 只保留一个界面入口 | 需要改变当前 IBAN 桥接与字段选择逻辑，并处理 QR、电子发票及并存账户 | 暂不采用 |
| 将 IBAN 改名为 Account number | 改动看似少 | 会把 NZ 账号继续写入 IBAN 列并传入 IBAN 专用消费者 | 不采用 |

这是计划作者根据代码作出的选择，未将其记作用户已经批准的产品决定。

## 用户行为和数据契约

- 新方式 ID 固定为 `bank_transfer_nz`，标签固定为 `Bank transfer (New Zealand)`，排列在现有 `bank_transfer` 后。
- 所有公司均可配置，默认关闭；不根据公司注册国家、客户国家或单据币种隐式启用或隐藏。
- 一个公司只配置一组 NZ 资料，存在现有 `CompanyPaymentMethodConfig.config`，不增加 Prisma 列或数据库迁移。
- 字段固定：`accountName`（Account name，必填）、`accountNumber`（Account number，必填）、`bankName`（Bank name，选填）。均沿用 `kind: 'text'`。
- 账户名采用单行文本，去除首尾空白后至少一个字符，最长 200 个字符；银行名称选填，非空时采用同样规则。
- 账号按字符串处理，支持 2 位银行号、4 位分行号、7 位账号主体和 2 或 3 位后缀。完整保留前导零及原有后缀宽度。
- 接受三类输入：`12-3456-0123456-00` / `12-3456-0123456-000`；相同四段以一个或多个 ASCII 空格分隔；无分隔符的 15 或 16 位数字。允许首尾 ASCII 空格。
- 拒绝混合分隔符、缺少分段、字母、小数、科学计数法、斜杠、换行、制表符、Unicode 数字及其他标点；不得用“删掉所有非数字字符”的方式修复输入。
- 本期原样保存通过校验的输入，界面预览与 PDF/邮件保持相同文本。禁止数值转换、自动补齐账号主体、删除三位后缀首位或擅自改写账号。
- 仅验证结构；通过格式校验不代表银行、分行、账户存在或收款人名称匹配。
- 不增加 SWIFT/BIC 字段；本期覆盖标准本地转账资料，不宣称已完整支持国际电汇或银行的特殊外币账户格式（例如 BNZ 的六位账号加四位后缀）。

以上示例只作格式测试，不代表有效或可收款的账户。

## 校验和安全边界

- 后端保留 `validateAgainstDescriptor`，为支付方式描述符增加一个可选 `validateConfig(config): ValidationError[]` 回调；共享 `validationErrorsFor` 合并结构错误与方式错误。
- 回调为纯校验，不修改参数、不访问数据库、不打印账号。没有回调的原六种方式保持原有行为。
- 必填字段缺失与类型错误交给结构校验；回调检查已提供的字符串的格式、空白和长度，避免重复错误。
- `configured` 和所有启用/已启用配置写入使用同一套后端校验。拒绝无效写入必须发生在任何持久化之前。
- 保留现有 disabled draft 语义：关闭方式可保存不完整文本资料，`configured` 为 false；启用时必须有效。前端保存仍先进行完整表单校验，与现有行为一致。
- 在持久化入口明确拒绝显式提供的非对象 `config`（null、数组、数字、字符串）；省略 `config` 的开关操作仍然有效。
- 沿用 OWNER/ADMIN 与 `company:write` 写入权限、`company:read` 读取权限和所有 companyId 查询约束。
- 为结构化日志补齐 `accountNumber`、`bankAccountNumber`、`accountName` 敏感键脱敏；错误文本不包含输入值。不要新增账号埋点或请求日志。

## 输出和兼容

- `presentFromFields` 输出账户名、账号和非空银行名；没有 IBAN/BIC 标签，没有链接，没有自动标记已支付。
- PDF 和邮件沿用 `resolveEnabledPaymentMethodPresentations`；不得另建 NZ 专用渲染流程。
- 仅在原本展示付款方式的单据及页面上展示，沿用该处既有过滤条件。
- 客户未受限制时，遵循公司启用状态；客户受限制时，仅当允许列表含 `bank_transfer_nz` 才展示。`bank_transfer` 不自动等价于 `bank_transfer_nz`。
- 现有 IBAN/BIC、历史付款记录、SEPA QR、电子发票和国家专用传输行为保持兼容。NZ 资料不进入 `Company.iban/bic` 或 `seller.iban`。
- 本期不扩展电子发票 XML 中的 NZ 收款账户映射。现有“必须有 IBAN”或“不支持此方式”的具名拒绝必须保留，禁止伪装成已支持。
- 两种银行方式可以同时开启；都允许时都会展示。用户若只使用 NZ 本地账户，应只开启新方式。
- 不猜测迁移过去填进 IBAN 的 NZ 账号。文档引导用户核对后人工重配，显式调整客户限制；代码不得自动清空旧资料。

## 验收标准

1. 配置 NZ 收款资料时不需要填写 IBAN，刷新和重新打开后资料保留。
2. 两位和三位后缀、所有前导零以及支持的粘贴格式正确往返；无效账号不能启用。
3. 通过直接 API 提交也执行校验；失败后原有账户和启用状态不变。
4. UI 预览、实际生成的 PDF 和邮件中都以 Account number 展示相同账号。
5. 禁用方式或客户不允许该方式时，不输出收款资料；其他租户不能读写该配置。
6. 原有 `bank_transfer`、IBAN 专用输出、在线支付、金额及到账状态不回归。
7. 新账号/账户名敏感键被日志脱敏；输出继续经过既有 HTML 转义。

## 官方依据（核查日期：2026-11-16）

- [ANZ：Receive money from overseas](https://www.anz.co.nz/personal/fx-international/receive-money-from-overseas/)：NZ 不使用 IBAN；说明了两位后缀在需要 16 位账号时补零的场景。本设计选择保留用户输入的后缀宽度。
- [BNZ：International payments to New Zealand](https://www.bnz.co.nz/support/international/payments/made-to-new-zealand)：列出银行、分行、七位账户主体及三位后缀的完整格式。
- [Kiwibank：Account numbers](https://www.kiwibank.co.nz/help/accounts/open-manage/account-numbers/)：说明四段结构和两位后缀。
- [ASB：What is an IBAN?](https://www.asb.co.nz/help/what-is-an-iban.html)：给出以空格分段的本地账号示例。

这些资料用于确认账号结构。本期不实现汇款、银行账户真实性或所有权校验。
