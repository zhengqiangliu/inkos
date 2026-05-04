# Studio 右侧 Tab 面板改造发布说明

日期：2026-05-03
范围：`packages/studio`（小说项目详情页 / Chat 右侧面板）

## 目标

将右侧侧栏从单一纵向信息流改造为 Tab 化结构，提升可读性与操作效率，减少“章节/设定/审计/资产”混杂带来的认知负担。

## 主要变更

1. 右侧面板改为 5 个 Tab
- 章节
- 大纲
- 设定
- 审计修订
- 资产版本

2. 状态记忆
- 按书籍记忆最后一次 Tab：`studio.book.right-tab.{bookId}`

3. 自动切换
- 收到 `audit/revise/rewrite` 结果事件时，自动切到“审计修订”
- 检测到设定冲突类日志时，自动切到“设定”

4. Tab Badge
- 章节：运行中脉冲点
- 审计修订：失败章节计数（`audit-failed` / `needs-revision` / `state-degraded`）
- 资产版本：待发布章节计数（`ready-for-review`）

5. 移动端适配
- Drawer 下保留 Tab 顶栏
- 短文案：`审计修订→审计`、`资产版本→版本`
- 窄屏间距与可读性优化

## 关键文件

- `packages/studio/src/components/chat/BookSidebar.tsx`
- `packages/studio/src/components/chat/__tests__/BookSidebar.test.ts`

## 验证结果

- `pnpm -C packages/studio typecheck`：通过
- `pnpm -C packages/studio test`：通过（32 files / 308 tests）

## 回归风险

- 自动切 Tab 依赖 SSE 事件与日志关键字；如后端事件命名或日志模板变化，自动切换触发率可能受影响。
- Badge 统计依赖章节状态字段；若后端新增状态枚举，需同步映射。

## 回滚策略

- 回滚 `BookSidebar.tsx` 与 `BookSidebar.test.ts` 本次改动即可恢复旧侧栏行为。
