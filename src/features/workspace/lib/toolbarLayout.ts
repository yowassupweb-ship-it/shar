/**
 * Панель инструментов документа и таблицы — в порядке Google Документов и Таблиц: люди приходят оттуда и ищут
 * кнопки на привычных местах. Настраивается штатным параметром Univer `menu` (id пункта или группы → hidden / order).
 * Убранное из строки не пропадает: оно есть в строке меню над панелью («Правка», «Вставка», «Формат», «Данные»)
 * и в «⋮» в конце панели.
 */
import type { MenuConfig } from '@univerjs/ui';

const hide = { hidden: true };

/** Таблица: ↶ ↷ кисть | ₽ % .0 .00 123 | шрифт, размер | Ж К З цвет | заливка, границы, объединить | выравнивание… */
export const SHEET_TOOLBAR: MenuConfig = {
  // В Google этих кнопок нет в строке: вставка и очистка формата — в «Правке» и «Формате», размер шрифта ± — полем.
  'sheet.menu.paste': hide,
  'ui.command.clear-formatting': hide,
  'sheet.command.set-range-font-increase': hide,
  'sheet.command.set-range-font-decrease': hide,
  'sheet.command.set-range-underline': hide,
  'sheet.command.set-shrink-to-fit': hide,
  'sheet.command.add-range-protection-from-toolbar': hide,
  'base-ui.operation.toggle-shortcut-panel': hide,
  'ui.operation.open-feature-search': hide,
  // Числовые форматы — сразу после отмены и кисти, как у Google: ₽ % .0 .00 123.
  'ribbon.start.number': { order: 0.5 },
  'sheet.command.numfmt.set.currency': { order: 1 },
  'sheet.command.numfmt.set.percent': { order: 2 },
  'sheet.command.numfmt.subtract.decimal.command': { order: 3 },
  'sheet.command.numfmt.add.decimal.command': { order: 4 },
  'sheet.operation.open.numfmt.panel': { order: 5 },
  // Объединить — рядом с заливкой и границами, перед выравниванием.
  'sheet.command.add-worksheet-merge': { order: -1 },
  // «⋮» у Google — короткий ряд оставшихся кнопок, а не все вкладки Excel. Категории функций — одной кнопкой Σ
  // (полный список — «Вставка → Функция»); поиск, сортировка, сетка и полный экран — в строке меню.
  'formula-ui.operation.insert-function.financial': hide,
  'formula-ui.operation.insert-function.logical': hide,
  'formula-ui.operation.insert-function.text': hide,
  'formula-ui.operation.insert-function.date': hide,
  'formula-ui.operation.insert-function.lookup': hide,
  'formula-ui.operation.insert-function.math': hide,
  'formula-ui.operation.insert-function.statistical': hide,
  'formula-ui.operation.insert-function.engineering': hide,
  'formula-ui.operation.insert-function.information': hide,
  'formula-ui.operation.insert-function.database': hide,
  'ui.operation.open-find-dialog': hide,
  'sheet.menu.sheets-sort': hide,
  'sheet.command.toggle-gridlines': hide,
  'base-ui.operation.toggle-fullscreen': hide,
  // Σ — коротко, как у Google; полный список функций — «Вставка → Функция».
  'formula-ui.operation.insert-function.common': { title: 'Функции' },
  // Ссылка уже есть на панели своей кнопкой (nx.link.sheet).
  'sheet.operation.insert-hyper-link-toolbar': hide,
};

/** Документ: ↶ ↷ кисть | стиль, шрифт, размер | Ж К Ч цвет, выделение, ссылка | выравнивание, списки. */
export const DOC_TOOLBAR: MenuConfig = {
  'doc.command.paste-special': hide,
  'ui.command.clear-formatting': hide,
  'doc.command.set-inline-format-strikethrough': hide,
  'doc.command.set-inline-format-subscript': hide,
  'doc.command.set-inline-format-superscript': hide,
  'doc.command.open-header-footer-panel': hide,
  'docs.operation.open-page-setting': hide,
  'doc.operation.open-permission-panel': hide,
  'base-ui.operation.toggle-shortcut-panel': hide,
  'ui.operation.open-feature-search': hide,
  'doc.command.set-paragraph-named-style': { order: 0 },
  'doc.command.set-inline-format-font-family': { order: 1 },
  'doc.command.set-inline-format-fontsize': { order: 2 },
  'doc.command.set-inline-format-bold': { order: 3 },
  'doc.command.set-inline-format-italic': { order: 4 },
  'doc.command.set-inline-format-underline': { order: 5 },
  'doc.command.set-inline-format-text-color': { order: 6 },
  'doc.command.set-inline-format-text-background-color': { order: 7 },
};
