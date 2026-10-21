# usage-limits

Мод для Claude Code, який показує над полем введення один рядок: заповнення контекстного вікна поточної сесії, п'ятигодинний ліміт підписки й тижневий ліміт, разом із часом до скидання.

```
Контекст ███░░░░░░░ 34% 68k/200k  ·  Сесія ██░░░░░░░░ 23% 2 год 20 хв  ·  Тиждень ████░░░░░░ 41% 3 дн 5 год
```

*English: a Claude Code mod that draws a single row above the prompt with the context window fill, the five-hour usage limit and the weekly usage limit, each with a bar and the time left until it resets. The labels are in Ukrainian; change them in `hooks/register.tsx`.*

## Що показує

- **Контекст**: відсоток заповнення контекстного вікна і `токени/вікно`.
- **Сесія**: відсоток п'ятигодинного ліміту підписки і скільки лишилося до його скидання.
- **Тиждень**: відсоток тижневого ліміту і скільки лишилося до скидання.
- Смужка й відсоток зелені до 70%, жовті від 70% і червоні від 90%.
- Відлік оновлюється сам раз на 30 секунд, а дані приходять після кожної відповіді моделі.
- Ліміти підписки є лише в акаунтів із підпискою, і лише після першої відповіді в сесії. Без них показується тільки контекст.
- Якщо вікно ліміту вже скинулось, замість часу напишеться "щойно скинуто".
- У вузькому вікні рядок обрізається з кінця, а не переноситься.

## Встановлення

У десктопному застосунку (там `/plugin` не працює): натисніть `+` біля поля введення, далі Plugins, Add marketplace з `taran-7/claude-usage-limits`, потім Add plugin і `usage-limits`.

У терміналі, у сесії Claude Code:

```
/plugin install usage-limits --marketplace taran-7/claude-usage-limits
```

З оболонки:

```
claude plugin install usage-limits --marketplace taran-7/claude-usage-limits
```

Claude Code спитає `Add marketplace?`, відповідайте `y`, потім оберіть область (user scope стоїть першою). Після цього мод працює в усіх нових сесіях.

Перевірено на Claude Code 2.1.299.

## Розробка

```
claude plugin validate .
claude plugin test .
```

`claude` у вашому PATH може бути старішим за вбудований у десктопний застосунок. Якщо `plugin test` невідома команда або валідатор не знає подію `session.measure`, запустіть бінарник із застосунку: `~/Library/Application Support/Claude/claude-code/<версія>/<хеш>/claude.app/Contents/MacOS/claude`.

Підписи (`Контекст`, `Сесія`, `Тиждень`, `дн`, `год`, `хв`) лежать у `hooks/register.tsx`.
