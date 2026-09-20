#!/usr/bin/env python3
"""Add reviewed learning/history chrome translations, preserving existing catalog entries.

Run from any directory. A second run makes no changes. The mobile i18n test checks
coverage and placeholder parity; language quality still needs native-speaker review.
"""
import json
from pathlib import Path

# English source id, Chinese, Russian. Keep interpolation names unchanged.
TRANSLATIONS = [
    ("Delivery unconfirmed", "送达状态未确认", "Доставка не подтверждена"),
    ("Restore memory", "恢复记忆", "Восстановить память"),
    ("Review undo", "审核撤销", "Проверить отмену"),
    ("Reason for undo", "撤销原因", "Причина отмены"),
    ("Restore this fact", "恢复此事实", "Восстановить этот факт"),
    ("Remove this fact", "移除此事实", "Удалить этот факт"),
    ("Confirm restoration", "确认恢复", "Подтвердить восстановление"),
    ("Confirm removal", "确认移除", "Подтвердить удаление"),
    ("Preview change", "预览更改", "Предпросмотр изменения"),
    ("Retry confirmation", "重试确认", "Повторить подтверждение"),
    ("Could not confirm the change. Retry or reload history.", "无法确认更改。请重试或重新加载历史记录。", "Не удалось подтвердить изменение. Повторите попытку или обновите историю."),
    ("Provider memory history", "记忆服务历史记录", "История памяти у провайдера"),
    ("Save memory", "保存记忆", "Сохранение памяти"),
    ("Remove memory", "移除记忆", "Удаление памяти"),
    ("Undo memory save", "撤销记忆保存", "Отмена сохранения памяти"),
    ("Memory change", "记忆更改", "Изменение памяти"),
    ("Confirmed", "已确认", "Подтверждено"),
    ("Outcome unknown", "结果未知", "Результат неизвестен"),
    ("Original change", "原始更改", "Исходное изменение"),
    ("Requested content", "请求内容", "Запрошенное содержимое"),
    ("Recorded versions are unavailable.", "记录的版本不可用。", "Записанные версии недоступны."),
    ("Not stored", "未存储", "Не сохранено"),
    ("The provider outcome is unknown. Verify it before another change.", "记忆服务的处理结果未知。请先核实，再进行更改。", "Результат операции у провайдера неизвестен. Проверьте его перед следующим изменением."),
    ("After", "之后", "После"),
    ("Applied", "已应用", "Применено"),
    ("Applied version {revision}", "已应用版本 {revision}", "Применена версия {revision}"),
    ("Applies when", "适用条件", "Условия применения"),
    ("Apply change", "应用更改", "Применить изменение"),
    ("Approve change", "批准更改", "Одобрить изменение"),
    ("Approved", "已批准", "Одобрено"),
    ("Available to future runs", "可用于后续运行", "Доступно для последующих запусков"),
    ("Before", "之前", "До"),
    ("Cancel review", "取消审核", "Отменить проверку"),
    ("Change saved.", "更改已保存。", "Изменение сохранено."),
    ("Change saved. Reload to see the latest version.", "更改已保存。重新加载以查看最新版本。", "Изменение сохранено. Обновите, чтобы увидеть последнюю версию."),
    ("Changes a business rule.", "此更改会修改业务规则。", "Изменяет бизнес-правило."),
    ("Contains guidance for staff only.", "包含仅供员工使用的指导。", "Содержит рекомендации только для сотрудников."),
    ("Could not complete this review. Reload history and try again.", "无法完成此审核。请重新加载历史记录后重试。", "Не удалось завершить проверку. Обновите историю и попробуйте снова."),
    ("Could not complete this review. Reload updates and try again.", "无法完成此审核。请重新加载更新后重试。", "Не удалось завершить проверку. Обновите список изменений и попробуйте снова."),
    ("Could not finish", "未能完成", "Не удалось завершить"),
    ("Could not load history. Try again.", "无法加载历史记录。请重试。", "Не удалось загрузить историю. Попробуйте снова."),
    ("Current", "当前", "Текущая версия"),
    ("Earlier content is unavailable.", "较早的内容不可用。", "Предыдущее содержимое недоступно."),
    ("Empty", "空", "Пусто"),
    ("History", "历史记录", "История"),
    ("I reviewed the overlapping changes", "我已审核重叠的更改", "Я проверил пересекающиеся изменения"),
    ("I reviewed the overlapping edits.", "我已审核重叠的编辑。", "Я проверил пересекающиеся правки."),
    ("Later edits overlap. Review the result before applying.", "后续编辑存在重叠。请先审核结果再应用。", "Последующие правки пересекаются. Проверьте результат перед применением."),
    ("Learning queued. Reload updates when it finishes.", "学习任务已排队。完成后请重新加载更新。", "Обучение поставлено в очередь. После завершения обновите список изменений."),
    ("Learning restarted", "已重新开始学习", "Обучение запущено повторно"),
    ("Learning update", "学习更新", "Изменение по итогам обучения"),
    ("Learning updates", "学习更新", "Изменения по итогам обучения"),
    ("Learning…", "正在学习…", "Обучение…"),
    ("Memory and skill history", "记忆和技能历史记录", "История памяти и навыков"),
    ("Memory history", "记忆历史记录", "История памяти"),
    ("More skills", "更多技能", "Ещё навыки"),
    ("Needs review", "需要审核", "Требует проверки"),
    ("No change needed", "无需更改", "Изменения не нужны"),
    ("No learning updates.", "暂无学习更新。", "Нет изменений по итогам обучения."),
    ("No recorded changes yet.", "尚无更改记录。", "Изменений пока нет."),
    ("Older changes", "较早的更改", "Более ранние изменения"),
    ("Older updates", "较早的更新", "Более ранние обновления"),
    ("Private across your bots", "仅你拥有的各个机器人可用", "Личное, для всех ваших ботов"),
    ("Private to this bot", "仅此机器人私用", "Личное, только для этого бота"),
    ("Reason for decision", "决定理由", "Причина решения"),
    ("Recent decisions", "近期决定", "Последние решения"),
    ("Regenerate", "重新生成", "Сформировать заново"),
    ("Reject", "拒绝", "Отклонить"),
    ("Rejected", "已拒绝", "Отклонено"),
    ("Reload history", "重新加载历史记录", "Обновить историю"),
    ("Reload updates", "重新加载更新", "Обновить список изменений"),
    ("Removed from future runs", "后续运行将不再使用", "Исключено из последующих запусков"),
    ("Replaces the entire current version.", "将替换整个当前版本。", "Полностью заменяет текущую версию."),
    ("Restore version", "恢复版本", "Восстановить версию"),
    ("Restored", "已恢复", "Восстановлено"),
    ("Result", "结果", "Результат"),
    ("Retry learning", "重试学习", "Повторить обучение"),
    ("Review restore", "审核恢复", "Проверить восстановление"),
    ("Review undo", "审核撤销", "Проверить отмену"),
    ("Shared across this Space", "在此空间共享", "Общее для этого пространства"),
    ("Source conversation", "来源对话", "Исходный разговор"),
    ("Suggestion rejected.", "建议已拒绝。", "Предложение отклонено."),
    ("The destination changed. Regenerate this proposal before approving it.", "目标内容已更改。请重新生成此建议后再批准。", "Целевой документ изменился. Сформируйте предложение заново перед одобрением."),
    ("The source does not fully support this suggestion. Review the evidence.", "来源未完全支持此建议。请审核依据。", "Источник не полностью подтверждает это предложение. Проверьте исходные данные."),
    ("This bot", "此机器人", "Этот бот"),
    ("Undone", "已撤销", "Отменено"),
    ("Version {revision}", "版本 {revision}", "Версия {revision}"),
    ("{name} · Removed", "{name} · 已移除", "{name} · Удалено"),
]

root = Path(__file__).resolve().parents[1]
for column, locale in [(1, "zh"), (2, "ru")]:
    path = root / "apps/mobile/lib/locales" / f"{locale}.ts"
    original = path.read_text()
    additions = []
    for row in TRANSLATIONS:
        key = json.dumps(row[0], ensure_ascii=False)
        # Existing keys can be unquoted identifiers or quoted source strings.
        if f"  {key}:" in original or f"  {row[0]}:" in original:
            continue
        additions.append(f"  {key}: {json.dumps(row[column], ensure_ascii=False)},\n")
    if additions:
        path.write_text(original.replace(" = {\n", " = {\n" + "".join(additions), 1))
    print(f"{locale}: added {len(additions)} translations")
