# Studio 小说项目详情页右侧 Tab 改造任务清单

更新时间：2026-05-03

## 本轮优化（去重与布局）

- [x] 章节列表改为填充容器高度，列表区内部滚动
- [x] 取消“审计修订”Tab，整合到“章节”Tab筛选（全部/待审/未通过）
- [x] 资产Tab移除重复核心文件列表，改为版本与导出入口
- [x] 大纲Tab移除重复核心文件块，仅保留大纲相关入口
- [x] 回归验证（typecheck + 关键测试）通过

## 当前进度

- 本轮优化：`100%`（已完成）
- 右侧面板整体：`100%`（已完成）

## 备注

- 验证命令：
  - `pnpm -C packages/studio typecheck`
  - `pnpm -C packages/studio test -- src/components/chat/__tests__/BookSidebar.test.ts src/components/sidebar/ChaptersSection.test.ts src/hooks/use-book-activity.test.ts`
