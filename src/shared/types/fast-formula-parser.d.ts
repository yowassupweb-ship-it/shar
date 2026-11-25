// fast-formula-parser (MIT) без своих типов: пользуемся парсером, SSF и FormulaError — см. sheet/formulas.ts.
declare module 'fast-formula-parser' {
  const FormulaParser: unknown;
  export default FormulaParser;
}
