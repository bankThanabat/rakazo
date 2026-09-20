#!/usr/bin/env python3
"""Add approval review labels without rewriting unrelated catalog entries. Safe to rerun."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LABELS = ["Review memory change", "Review skill change", "Request details"]
TRANSLATIONS = {
    "en": LABELS,
    "de": ["Speicheränderung prüfen", "Skill-Änderung prüfen", "Anfragedetails"],
    "ko": ["메모리 변경 검토", "스킬 변경 검토", "요청 세부 정보"],
    "tr": ["Bellek değişikliğini incele", "Beceri değişikliğini incele", "İstek ayrıntıları"],
    "hi": ["मेमोरी में बदलाव की समीक्षा करें", "कौशल में बदलाव की समीक्षा करें", "अनुरोध का विवरण"],
    "pt-BR": ["Revisar alteração de memória", "Revisar alteração de habilidade", "Detalhes da solicitação"],
    "zh-CN": ["审核记忆更改", "审核技能更改", "请求详情"],
    "es": ["Revisar cambio de memoria", "Revisar cambio de habilidad", "Detalles de la solicitud"],
    "ru": ["Проверить изменение памяти", "Проверить изменение навыка", "Детали запроса"],
}
quote = lambda text: json.dumps(text, ensure_ascii=False)
for locale, values in TRANSLATIONS.items():
    path = ROOT / f"apps/web/src/locales/{locale}/messages.po"
    original = path.read_text()
    additions = "".join(
        f'\n#: src/components/LearningApprovalDetail.tsx\nmsgid {quote(key)}\nmsgstr {quote(value)}\n'
        for key, value in zip(LABELS, values, strict=True)
        if f"msgid {quote(key)}\n" not in original
    )
    if additions:
        path.write_text(original + additions)
for locale, filename in [("ru", "ru"), ("zh-CN", "zh")]:
    path = ROOT / f"apps/mobile/lib/locales/{filename}.ts"
    original = path.read_text()
    additions = "".join(
        f"  {quote(key)}: {quote(value)},\n"
        for key, value in zip(LABELS, TRANSLATIONS[locale], strict=True)
        if f"  {quote(key)}:" not in original
    )
    if additions:
        path.write_text(original.replace(" = {\n", " = {\n" + additions, 1))
