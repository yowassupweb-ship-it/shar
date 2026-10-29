// Раскладка документа (строки, страницы) в отдельном потоке: печать не ждёт пересчёта всего текста.
import { startDocsLayoutWorker } from '@univerjs/docs';

startDocsLayoutWorker();
