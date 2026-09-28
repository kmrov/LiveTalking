# LiveTalking Studio Avatar Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Пользователь создаёт аватара из фото/видео в Studio, сохраняет его с исходником и понятным именем и выбирает из библиотеки без ввода slug.

**Architecture:** Electron main управляет локальной библиотекой, узким IPC и одним отдельным Python-процессом подготовки. Worker нормализует медиа, вызывает существующие генераторы и проверяет результат; main публикует только готовый каталог. Подготовка первого аватара независима от Qwen, голоса, HTTP-сервера и «Бати».

**Tech Stack:** Linux, Node.js >= 22, Electron 44, ES modules, существующий renderer без UI-фреймворка, Python LiveTalking, Pillow/OpenCV/PyTorch, локальные MuseTalk/Wav2Lip и FFmpeg для видео; node:test, unittest и существующий Playwright Electron smoke.

**Spec:** `docs/superpowers/specs/2026-09-28-livetalking-desktop-avatar-library-design.md`. Прочитать её вместе с этим планом. Уточнение Wav2Lip при планировании: текущий сервер использует 256×256; значение `modelres` не используется для его кадров.

## Global Constraints

- «Пользователь создаёт аватара прямо в Electron: выбирает фото или видео, задаёт понятное имя, наблюдает подготовку и затем выбирает результат по имени и миниатюре».
- «MuseTalk v15 создаёт аватары из PNG/JPEG и видео MP4/MOV/MKV/AVI»; Wav2Lip создаёт только из видео; Ultralight только выбирается.
- «Голос остаётся настройкой существующего профиля: WAV и точная расшифровка».
- «Структурированные строки stdout имеют отдельный префикс `LT_AVATAR `»; версия JSON-протокола — 1.
- «ID `studio_<UUID без дефисов>`»; готовый каталог — `data/avatars/<generatedId>`, рабочий — `data/.studio-avatar-work/<jobId>`.
- «Имя — непустая строка до 120 символов без NUL и управляющих символов»; кириллица и одинаковые имена разрешены.
- «Старые profiles.json совместимы: версия профиля остаётся 1»; выбор сохраняет пару `model`/`avatarId` через существующий store.
- «Пока задача активна, запуск профиля и смена root/Python в интерфейсе недоступны»; одна задача, без очереди.
- «После остановки профиль автоматически не перезапускается ни при успехе, ни при ошибке, ни при отмене подготовки».
- «Подключённые сторонние процессы/контейнеры и том PostgreSQL сохраняются»; сигналы отправляются только группе собственного worker.
- «Studio проверяет зависимости и сообщает, чего не хватает; автоматически устанавливать пакеты и скачивать модели этот сценарий не должен».
- Редактировать исходники, не `desktop/dist`; сохранить всю существующую staged/unstaged работу. Не устанавливать зависимости без обнаруженной необходимости. Базы — только отдельные тестовые.

## Review Focus

- Исходник заменён/удалён между диалогом и созданием: отказ с просьбой выбрать заново; после собственной копии исходник уже не нужен. Тесты задачи 3.
- Один неверный кадр в остальном пригодном видео: явная ошибка подготовки, без рассинхронизации масок/латентов и без публикации. Тесты задачи 2.
- Приложение аварийно завершилось между rename результата и сохранением `completed`: восстановление находит карточку и завершает запись, без второго аватара. Тесты задачи 4.
- Переключение аватара во время незавершённой записи или отправки запроса «Бате»: запись не теряется, клиентские события старой сессии не попадают в новую; сервер Бати сохраняет свой ответ. Тесты задач 5–7.
- Очень большой кадр/журнал или ошибочный manifest: библиотека остаётся отзывчивой; превью/журнал ограничены, ошибка отдельной карточки не прерывает весь список. Тесты задач 1, 3 и 4.

---

## Порядок выполнения и файлы

Выполнять задачи 1–7 последовательно. Перед выполнением использовать `using-git-worktrees`: выбрать изолированную рабочую копию с учётом существующих изменений пользователя. Документы уже находятся в основном checkout; не сбрасывать его и не включать чужие изменения в коммиты задачи. После последней проверки провести обзор итогового diff по `requesting-code-review`.

| Файл | Ответственность |
| --- | --- |
| `desktop/src/avatar-contract.mjs` | Разрешённые модели/параметры, имена, типы медиа, нормализация запросов |
| `desktop/electron/avatar-library.mjs` | Каталог, manifests, переименование, ограниченные миниатюры и публикация |
| `server/desktop_avatar_media.py` | Нормализация/проверка медиа и результатов без импортов моделей при загрузке модуля |
| `scripts/prepare_desktop_avatar.py` | Probe/preview и worker-протокол, локальные зависимости и адаптер генераторов |
| `avatars/musetalk/genavatar.py`, `avatars/musetalk/utils/preprocessing.py`, `avatars/wav2lip/genavatar.py` | Точечные проверки пустых кадров/лиц/кропа с сохранением публичных сигнатур |
| `desktop/electron/avatar-sources.mjs` | Непрозрачные токены выбранных файлов, fingerprint и безопасное превью |
| `desktop/electron/avatar-prerequisites.mjs` | Проверка создания через probe, без Qwen/голоса/Бати |
| `desktop/electron/avatar-jobs.mjs` | Worker, состояния, постоянные записи, отмена, журнал, восстановление |
| `desktop/electron/avatar-runtime.mjs` | Сериализация создания, выбора, запуска/остановки и проверка профильной пары |
| `desktop/electron/main.mjs`, `preload.cjs`, `prerequisites.mjs` | Wiring IPC, shutdown и проверка библиотеки при запуске |
| `desktop/renderer/avatar-library.mjs`, `avatar-library-state.mjs` | Диалоги, карточки, форма, чистые функции фильтра/доступности действий |
| `desktop/renderer/studio.html`, `studio.css`, `studio.mjs` | Размещение и интеграция с текущей сессией |
| `desktop/scripts/avatar-fixture-worker.mjs`, `smoke-electron.mjs` | Контролируемая подготовка и сквозная проверка интерфейса |

## Общие контракты между задачами

Все пути в таблице файлов относительно LiveTalking. JavaScript возвращает plain objects; JSDoc-типы объявить рядом с производящим интерфейсом, не добавлять TypeScript toolchain.

- `AvatarEntry = { id, name, model, ready, reason, origin, thumbnail }`: `model` — одна из трёх моделей или `null`, `origin` — `existing`/`studio`, `thumbnail` — ограниченный image data URL или `null`. Список не содержит рабочих каталогов.
- `SourceSelection = { token, fileName, kind, preview }`: `kind` — `image`/`video`, `preview` — data URL или `null`; путь остаётся только в main.
- `CreationInput = { root, python, sourceToken, name, model, parameters }`: параметры после нормализации содержат defaults. Retry принимает `{ root, python, jobId }` и использует собственную копию источника.
- `JobSnapshot = { schemaVersion: 1, jobId, avatarId, root, name, model, sourceKind, state, stage, progress, errorMessage, logPath, createdAt, updatedAt }`. Состояния: `checking`, `running`, `publishing`, `completed`, `failed`, `cancelling`, `cancelled`, `interrupted`. PID не сохраняется.
- `WorkerRequest = { schemaVersion: 1, jobId, avatarId, root, jobDir, sourceFile, sourceKind, name, model, parameters }`. Worker вычисляет `output/<avatarId>` только внутри jobDir. Нормализованный исходник не хранится в пользовательской папке.
- `WorkerEvent = { version: 1, jobId, state, stage, progress, message, frameCount? }`; `state` — `running`/`prepared`/`failed`, `prepared` допускается только после проверки результата. Main присваивает `completed` после публикации.
- `CheckResult = { id, state, detail, action }` соответствует существующим проверкам; state — `ready`/`missing`/`blocked`.
- Manifest 1: `{ schemaVersion: 1, avatarId, name, model, origin, createdAt, frameCount, sourceFile, parameters }`. Для `existing` неизвестные `createdAt`, `sourceFile`, `parameters` — `null`. Для `studio` источник — фиксированный относительный `source/input.<extension>`, не исходный абсолютный путь.

### Task 1: Контракты и сохранённая библиотека

**Files:** Create `desktop/src/avatar-contract.mjs`, `desktop/electron/avatar-library.mjs`; Test `desktop/test/avatar-contract.test.mjs`, `desktop/test/avatar-library.test.mjs`.

**Interfaces:**
- Produces `normalizeAvatarCreation({ name, model, kind, parameters }) -> { name, model, kind, parameters }`, `normalizeAvatarName(name) -> string`, `mediaKind(fileName) -> 'image'|'video'`.
- Produces `createAvatarLibrary({ makeThumbnail = async () => null, moveDirectoryNoReplace } = {}) -> { list(root), get(root, id), rename(root, id, name), publish(root, job) }`; все методы async. `get` возвращает `AvatarEntry|null`; `publish` принимает запись с WorkerRequest-полями, `python`, `frameCount` и возвращает готовую AvatarEntry. `moveDirectoryNoReplace(staged, final, context) -> Promise<void>` внедряется из main; `context` содержит `root`, `jobDir`, `avatarId`, `python`. Отсутствие адаптера разрешает просмотр, но не публикацию.

- [ ] **Step 1: Написать failing tests контрактов и каталога.** Использовать временные директории и непустые fixture-артефакты; production-код не десериализует pickle/PT. Assert: `mediaKind('Фото.JPG') === 'image'`; `mediaKind('clip.MOV') === 'video'`; MuseTalk defaults `{ bbox_shift: 0, extra_margin: 10, parsing_mode: 'jaw' }`; Wav2Lip defaults `{ pads: [0,10,0,0], nosmooth: false, face_det_batch_size: 16 }`. Reject имя длиной 121, пустое/управляющие символы, дробные числа, `bbox_shift` вне −50..50, `extra_margin` вне 0..100, parsing mode вне `jaw/neck/raw`, неверные pads, batch вне 1..128 и Wav2Lip+image. Границы принимаются.

```js
test('photo uses MuseTalk defaults and keeps its Russian name', () => {
  const input = normalizeAvatarCreation({ name: 'Мой аватар', model: 'musetalk', kind: 'image', parameters: {} });
  assert.equal(input.name, 'Мой аватар');
  assert.deepEqual(input.parameters, { bbox_shift: 0, extra_margin: 10, parsing_mode: 'jaw' });
  assert.throws(() => normalizeAvatarCreation({ ...input, model: 'wav2lip' }));
});
```
- [ ] **Step 2: Дополнить failing tests библиотеки.** `list` различает три модели и конфликтующие признаки, сохраняет соседние корректные карточки при испорченном JSON, численно сортирует 2/10, отклоняет дубли индексов и неполные маски/face_imgs; скрывает work root. `rename` сохраняет кириллицу/одинаковые имена без изменения ID/coords, corrupt manifest не затирается. `publish` оставляет готовый источник и manifest, не публикует неполный результат и не перезаписывает существующий ID. Симлинк каталога/coords/источника/миниатюры наружу отклоняется. Чрезмерно большой preview даёт `thumbnail: null` при сохранении готовности.
- [ ] **Step 3: Запустить RED.** `node --test desktop/test/avatar-contract.test.mjs desktop/test/avatar-library.test.mjs` из корня. Ожидается отказ из-за отсутствующих модулей/экспортов, затем конкретные assertion failures.
- [ ] **Step 4: Реализовать интерфейсы.** Ограничить типы и exact keys параметров; `nosmooth` принимает boolean. Проверять канонические корни, запрет symlink-артефактов, непустые файлы и согласованные числовые индексы. PNG/JPG/JPEG допустимы для кадров. Manifest max 64 KiB, данные первого кадра для thumbnail max 20 MiB, итоговый data URL max 512 KiB. NativeImage-конвертер внедряется из main; без конвертера карточка допустима без превью. Публикация — manifest/source/thumbnail в рабочем output и `moveDirectoryNoReplace` на том же filesystem; только после него готовая карточка. Сериализовать мутации внутри library. Проверка `exists` перед обычным rename сама по себе недостаточна: Linux может заменить уже существующий пустой каталог; адаптер задачи 2 обеспечивает no-replace атомарно.
- [ ] **Step 5: Запустить GREEN и commit.** Повторить команду шага 3: все тесты проходят. Commit только перечисленных файлов: `feat: add persistent avatar catalog and validated creation contracts`.

### Task 2: Python-подготовка медиа и генерация

**Files:** Create `server/desktop_avatar_media.py`, `scripts/prepare_desktop_avatar.py`; Modify `avatars/musetalk/genavatar.py`, `avatars/musetalk/utils/preprocessing.py`, `avatars/wav2lip/genavatar.py`; Test `tests/test_desktop_avatar_media.py`, `tests/test_desktop_avatar_worker.py`.

**Interfaces:**
- Consumes WorkerRequest/WorkerEvent из общих контрактов; совпадающие defaults и ограничения задачи 1.
- Produces Python `normalize_media(source: Path, kind: str, work_dir: Path) -> Path`, `validate_generated_avatar(output: Path, model: str) -> int`, `validate_face_box(box, frame_shape, order: str) -> tuple`, `inspect_creation(request: dict) -> list[dict]`, `preview_media(source: Path, kind: str, destination: Path) -> Path`, `publish_directory(staged: Path, final: Path) -> None`.
- Produces `run_job(request: dict, emit, generator_loader=None) -> dict` и CLI `--job <json>`, `--probe <json>`, `--preview <json>`, `--publish <json>`. Ответы дополнительных режимов имеют префиксы `LT_AVATAR_PROBE`, `LT_AVATAR_PREVIEW`, `LT_AVATAR_PUBLISH`; диагностика не смешивается с результатом. Publish принимает `{schemaVersion:1,root,jobDir,avatarId}` и выводит `{version:1,avatarId,path}` только после atomic no-replace rename.

- [ ] **Step 1: Написать failing tests медиа.** Pillow создаёт RGB/JPEG с EXIF rotation: выход — единственный `00000000.png` с исправленными размерами/ориентацией. Подменённый subprocess фиксирует FFmpeg argv: без shell, `-i` отдельным аргументом, `-an`, фильтр `fps=25`, output внутри work. Декодирование пустого/битого входа даёт русскую ошибку. `validate_face_box` отклоняет zero, отрицательные, выходящие за кадр и reversed координаты в обоих порядках MuseTalk/Wav2Lip.

```python
def test_face_box_rejects_missing_or_outside_face(self):
    for box in ((0, 0, 0, 0), (-1, 0, 30, 40), (0, 0, 400, 40)):
        with self.assertRaises(ValueError):
            validate_face_box(box, (100, 100, 3), order="xyxy")
```
- [ ] **Step 2: Написать failing tests worker.** Fake generator не импортирует настоящие модели, создаёт согласованные файлы и передаёт progress. Assert last state `prepared`, protocol version 1, нужный jobId, сохранённый собственный source, thumbnail и frameCount. Видео Wav2Lip вызывает generator с `img_size=256`; фото MuseTalk — с numeric input basename. Отдельный тест одного кадра без лица в видеоряду гарантирует failed и отсутствие `prepared`. Отдельно: нет маски/пустые latents/неравное число coords, path escape, отсутствующие локальные веса и CUDA, ENOSPC, ошибка копирования, failure exit. Сеть/auto-download не вызываются даже при отсутствующем s3fd.
- [ ] **Step 3: Запустить RED.** `.venv/bin/python -m unittest discover -s tests -p 'test_desktop_avatar_*.py' -v`. Ожидаются отсутствующие модули/функции, затем assertion failures.
- [ ] **Step 4: Реализовать media helpers и probe.** Pillow+`ImageOps.exif_transpose` для фото, FFmpeg subprocess для видео с унаследованной process group; argv-список, stderr в журнал. Probe проверяет источник, возможность записи, Python imports/CUDA, необходимые локальные веса до model import. Для MuseTalk нужны VAE/UNet configs/weights, face-parse-bisent и используемый s3fd; Whisper нужен запуску разговора, не этой подготовке. Детектор выбирает только существующий локальный файл/torch cache по действующему Python-окружению, без download. Probe/preview имеют timeout 30 s; probe не загружает модели на GPU. Disk check сообщает свободное место и блокирует заведомо невозможную копию, не обещает точный размер будущих кадров; ENOSPC обрабатывается на всех стадиях. `publish_directory` использует libc `renameat2` с `RENAME_NOREPLACE=1` через stdlib ctypes; нет небезопасного fallback. Тест проверяет уже существующий пустой и непустой final: оба сохраняются неизменными, staged остаётся на месте.
- [ ] **Step 5: Реализовать `run_job` и исправить ошибки генераторов.** Проверять job root/id/пути и повторять валидацию параметров. Источник копируется через временный файл и rename в work до нормализации. Генераторы импортируются lazily после checks; разрешить корректный пакетный импорт детектора в MuseTalk вместо несуществующего bare `face_detection`. Общий `validate_face_box` использовать перед crop/resize. Пустые кадры/отсутствие лица не пропускаются, mean range в preprocessing не делит на ноль. Сохранить generate_avatar/CLI signatures; никакой реорганизации inference. После result validation сохранить thumbnail max 256×256, JPEG, и сообщить `prepared`; ошибки дают ненулевой exit с понятным сообщением. Main позже перемещает собственный источник в `output/<id>/source`.
- [ ] **Step 6: Запустить GREEN и commit.** Повторить шаг 3; дополнительно `.venv/bin/python -m unittest discover -s tests -p 'test_desktop*.py' -v`: desktop-контракты проходят. Commit только файлы задачи: `feat: prepare desktop avatars from normalized local media`.

### Task 3: Выбор исходника и независимые проверки создания

**Files:** Create `desktop/electron/avatar-sources.mjs`, `desktop/electron/avatar-prerequisites.mjs`; Test `desktop/test/avatar-sources.test.mjs`, `desktop/test/avatar-prerequisites.test.mjs`.

**Interfaces:**
- Consumes contract normalization задачи 1 и CLI probe/preview задачи 2.
- Produces `createAvatarSources({ chooseFile, inspectPreview, stat, realpath, now, uuid }) -> { choose(profile), resolve(token, root), forgetAll() }`. `choose` async возвращает SourceSelection|null, `resolve` async возвращает проверенный `{ sourceFile, sourceKind }`.
- Produces `inspectAvatarPrerequisites({ root, python, sourceFile, sourceKind, name, model, parameters }, { runProbe } = {}) -> Promise<CheckResult[]>`; `runProbe` — argv-вызов соответствующего Python CLI, не shell.

- [ ] **Step 1: Написать failing tests.** Диалог cancelled возвращает null, кириллица/пробелы передаются одним argv, path не попадает в SourceSelection. Token относится к session/root и исходному dev/ino/size/mtime; неизвестный token, смена root, symlink-подмена, удаление или изменение файла требуют нового выбора. Провести Review Focus тест замены исходника после выбора. Проверить max 32 tokens, timeout и слишком большой preview: понятная ошибка/preview null без раскрытия произвольных файлов.
- [ ] **Step 2: Дополнить failing tests prerequisites.** В пустом checkout без avatar/voice/Qwen/brain при подготовленных нужных weights результаты готовы; Python/CUDA/face-parser/s3fd/FFmpeg missing имеют конкретное действие. Фото проходит без FFmpeg; видео — нет. Мусорные/truncated probe output и ненулевой exit не трактуются как успех.

```js
test('creation check only reports preparation prerequisites', async () => {
  const input = { root: '/tmp/Studio', python: '/tmp/Studio/.venv/bin/python', sourceFile: '/tmp/portrait.png', sourceKind: 'image', name: 'Портрет', model: 'musetalk', parameters: {} };
  const results = await inspectAvatarPrerequisites(input, { runProbe: async () => [{ id: 'gpu', state: 'ready', detail: 'CUDA', action: '' }] });
  assert.deepEqual(results.map(item => item.id), ['gpu']);
  assert.equal(results.every(item => item.state === 'ready'), true);
});
```
- [ ] **Step 3: Запустить RED.** `node --test desktop/test/avatar-sources.test.mjs desktop/test/avatar-prerequisites.test.mjs`.
- [ ] **Step 4: Реализовать интерфейсы.** System dialog фильтрует PNG/JPG/JPEG/MP4/MOV/MKV/AVI. Main создаёт tokens и проверяет fingerprint перед подготовкой; JSON probe/preview размещается в собственном временном каталоге и удаляется после запроса. Preview max 256×256 и data URL max 512 KiB. Начальная картинка может быть null с отображаемой причиной: наличие FFmpeg/декодера повторно проверяется при создании. Не запускать checkSetup всей голосовой студии для проверки создания.
- [ ] **Step 5: GREEN и commit.** Повторить шаг 3. Commit файлов задачи: `feat: validate avatar sources and preparation prerequisites`.

### Task 4: Задачи, отмена и восстановление

**Files:** Create `desktop/electron/avatar-jobs.mjs`; Test `desktop/test/avatar-jobs.test.mjs`.

**Interfaces:**
- Consumes `library.publish(root, job)` задачи 1, `inspectAvatarPrerequisites(input)` задачи 3 и WorkerRequest/Event задачи 2.
- Produces `createAvatarJobs({ library, inspectCreation, spawn, kill, emit, now, schedule, cancelSchedule, shutdownTimeoutMs = 5000 }) -> { start(input), retry({root,python,jobId}), cancel(jobId), shutdown(), recover(root), snapshot(root), isBusy() }`. Все операции кроме `isBusy` async; `start` input содержит canonical `root`, `python`, `sourceFile`, `sourceKind`, `name`, `model`, `parameters`, не renderer token. Возвращается JobSnapshot после постановки собственной checking-задачи, не ожидание полной генерации.

- [ ] **Step 1: Написать failing lifecycle tests с fake ChildProcess.** Только один spawn; checking занимает busy-slot до async probe, error и late progress не меняют terminal state. Разбитые на chunks события собираются, чужие version/jobId, NaN/out-of-range progress и строки >64 KiB игнорируются; stdout без префикса в log. Exit 0 без `prepared` и валидного output — failed. `prepared` до exit не публикует; exit 0 после prepared — publish и completed. Log не превышает 1 MiB, snapshot excerpt — последние 8 KiB.
- [ ] **Step 2: Написать failing cancellation/recovery tests.** SIGTERM только `-ownedPid`; через 5000 ms SIGKILL только той же подтверждённо живой группе. Одновременные cancel/shutdown ожидают одну остановку; checking без child тоже отменяется. Отмена при publishing отклоняется, completed не удаляется. Failed/cancelled/interrupted сохраняют source для retry; незавершённая копия не считается источником. Recover не сигналит PID и отмечает старую running запись interrupted. Review Focus: final существует после rename, job ещё publishing → completed без повторного spawn.

Контрольные assertions именованного теста `publishing recovery completes without signalling an old process`: `assert.equal((await jobs.recover(root)).state, 'completed')`, `assert.deepEqual(signals, [])`, `assert.equal(spawnCount, 0)`. Здесь `root` содержит единственный валидный final manifest и publishing job.json; `jobs` создан с fake `kill`/`spawn`, заполняющими эти счётчики. Для аналога без final ожидать `interrupted`.
- [ ] **Step 3: Запустить RED.** `node --test desktop/test/avatar-jobs.test.mjs`.
- [ ] **Step 4: Реализовать менеджер.** Atomic `job.json` до запуска и на этапах; bounded log append; stdout parse с generation token и terminal guards. Spawn Python с `-u`, cwd root, detached process group, `shell:false`, JSON request в work. При cancelling ждать `close`, чтобы pipe/log от дочернего FFmpeg не оставались открытыми; использовать process-group existence check и ограниченный shutdown, не считать exit лидера доказательством закрытия всей группы. На успехе публиковать validated output, затем фиксировать completed; shutdown при publishing ожидает завершение публикации. Собственный исходник переместить в final/source, удалить только промежуточные input/output внутри проверенного work root; при неудаче сохранить их. Retry использует сохранённый source и новый jobId/avatarId. Не выбирать карточку и не запускать профиль автоматически.
- [ ] **Step 5: GREEN и commit.** Повторить шаг 3, затем тесты задач 1/3 вместе с ним. Commit файлов задачи: `feat: supervise cancellable avatar jobs with recovery`.

### Task 5: IPC и совместимый выбор профиля

**Files:** Create `desktop/electron/avatar-runtime.mjs`; Modify `desktop/electron/main.mjs` (`runtimeSnapshot`, `startProfile`, `registerSetupIpc`, `before-quit`), `preload.cjs`, `prerequisites.mjs`; Test `desktop/test/avatar-runtime.test.mjs`, Modify `desktop/test/prerequisites.test.mjs`, `ipc-policy.test.mjs`.

**Interfaces:**
- Consumes задачи 1/3/4 и существующие profile store/supervisors.
- Produces `createAvatarRuntime({ library, jobs, sources, profiles, stopProfile, getServiceState, inspectCreation }) -> { list(profile), chooseSource(profile), checkCreation(input), create(input,{stopServices}), retry(input,{stopServices}), rename({root,id,name}), select(profile,id,{stopServices}), assertCanStart(profile), assertCanSave(profile), shutdown(), snapshot(profile), runLifecycle(operation) }`. Snapshot — `{ entries, job }`. `select` возвращает сохранённый нормализованный профиль. `assertCanStart`/`assertCanSave` async; `runLifecycle` сериализует операции и повторно проверяет busy внутри очереди.
- Preload имена: `avatarLibrary(profile)`, `chooseAvatarSource(profile)`, `checkAvatarCreation(input)`, `createAvatar(input, options)`, `retryAvatar(input, options)`, `cancelAvatar(jobId)`, `renameAvatar(input)`, `selectAvatar(profile,id,options)`, `avatarSnapshot(profile)`, `onAvatarSnapshot(listener)` с отпиской. IPC каналы `desktop:avatar-*`; event — `desktop:avatar-snapshot`. API version остаётся 1.

- [ ] **Step 1: Написать failing runtime tests.** Создание до сохранения голосового профиля возможно. Running profile без `stopServices:true` отклоняет create/select; при true сначала await stop, потом spawn/save, никогда restart. Два одновременных start/create и create/create не запускают оба действия. Save/root change во время busy и при запущенном профиле не меняет active model/root/python; обновление пары требует select. `select` выводит model из готовой карточки, сохраняет актуальные поля формы, отвергает missing/mismatched карточки и не меняет profile schema 1. Recover выполняется до initial autoStart; interrupted задача доступна после открытия.

Именованный тест `selection derives model and preserves unsaved voice fields` использует fake library с ready MuseTalk ID `portrait` и исходную форму Wav2Lip: после `runtime.select(profile,'portrait',{stopServices:false})` проверить `assert.equal(selected.schemaVersion,1)`, `assert.deepEqual([selected.liveTalking.model,selected.liveTalking.avatarId],['musetalk','portrait'])`, `assert.deepEqual(selected.speech,profile.speech)` и равенство сохранённого profile store результата.
- [ ] **Step 2: Обновить failing prerequisites/IPC tests.** Injected probe для ready avatar теперь возвращает проверенную структуру/модель, не просто exists. Пустой каталог и mismatch model блокируют avatar check с действием выбора. Все новые channels используют trusted sender policy; payload не принимает arbitrary executable/source path. Review Focus: остановка adopted supervisor не сигналит ему и не удаляет базу; незавершённый ответ Бати не отменяется API-вызовом Studio.
- [ ] **Step 3: RED.** `node --test desktop/test/avatar-runtime.test.mjs desktop/test/prerequisites.test.mjs desktop/test/ipc-policy.test.mjs`.
- [ ] **Step 4: Реализовать wiring.** Main конструирует modules, nativeImage-thumbnail converter и system dialog; остаётся тонким. Для `moveDirectoryNoReplace` использовать Python из publish context и `--publish` задачи 2 с timeout 30 s; проверить argv/ответ/exit, не допускать arbitrary target. IPC validate → sources.resolve → serialized runtime action. Все create/retry/select actions подтверждают stopping flag, main проверяет текущее service state. Start IPC и autoStart проходят тот же lifecycle gate; internal start/stop функции не захватывают тот же lock повторно. Cancel bypass-операция должна прерывать checking, не ждать удерживаемый стартом job lock. Initial setup включает `{ entries, job }`; before-quit ждёт job shutdown и существующий stopProfile даже при уже stopped service. subscribe игнорирует завершённое/чужое окно. Существующие brain/history IPC и ownership semantics не менять.
- [ ] **Step 5: GREEN и commit.** Повторить шаг 3; `npm test` в desktop проверяет совместимость существующих supervisor/profile/brain tests. Commit только файлы задачи: `feat: expose avatar library and lifecycle-safe selection to Studio`.

### Task 6: Библиотека и создание в интерфейсе

**Files:** Create `desktop/renderer/avatar-library.mjs`, `avatar-library-state.mjs`; Modify `desktop/renderer/studio.html`, `studio.css`, `studio.mjs`; Test `desktop/test/avatar-library-state.test.mjs`.

**Interfaces:**
- Consumes preload API задачи 5.
- Produces `mountAvatarLibrary({ document, bridge, getProfile, onProfileSelected, prepareSessionChange, getSessionState }) -> { refresh(), applySnapshot(snapshot), dispose() }`. `getProfile` возвращает актуальную formProfile; `prepareSessionChange` async запрещает recording/recordingBusy, завершает ASR, закрывает WebRTC/SSE и инвалидирует старые callbacks; `onProfileSelected` обновляет currentProfile и UI без запуска сервисов. `getSessionState` возвращает `{ serviceActive, recording, recordingBusy, generationBusy }`.
- Produces чистые `filterAvatars(entries,query) -> AvatarEntry[]`, `avatarActionState(session,job) -> { canCreate, canSelect, canStart, canChangeEnvironment, canCancel, canRetry, createLabel, selectLabel }`, `buildCreationInput(profile,selection,form) -> CreationInput` в state-модуле. Pure функции покрывают решения; фактический DOM/focus проверяется smoke.

- [ ] **Step 1: Написать failing state tests.** Поиск имени/ID case-insensitive; missing/invalid карточки недоступны. Image → MuseTalk, video → разрешены MuseTalk/Wav2Lip. Active job запрещает start/new create/root/python. Recording/recordingBusy запрещает create/select. Running service даёт exact action labels «Остановить и создать»/«Остановить и выбрать». completed даёт «Выбрать», error/interrupted — «Повторить». CreationInput не подменяет root/sourceToken переданным из form неизвестным полем.

```js
test('an active recording blocks stopping to create or select an avatar', () => {
  const action = avatarActionState({ serviceActive: true, recording: true, recordingBusy: false, generationBusy: false }, null);
  assert.equal(action.canCreate, false);
  assert.equal(action.canSelect, false);
  assert.equal(action.selectLabel, 'Остановить и выбрать');
});
```
- [ ] **Step 2: RED.** `node --test desktop/test/avatar-library-state.test.mjs`.
- [ ] **Step 3: Реализовать state и диалоги.** Блок «Аватары» в левой панели; библиотека на native `<dialog>` с поиском, обновлением, карточками, именем/моделью/ID/причиной и inline rename. Отдельный dialog создания: source preview, name, model, details параметров, проверка, этап, `<progress>`, cancel/retry. Тексты через textContent; no innerHTML пользовательских имён. status/alert и фокус согласно spec; Escape закрывает, не отменяет. Job подписка живёт вне dialog; reopen отображает актуальное состояние.
- [ ] **Step 4: Интегрировать Studio.** Убрать editable `avatar-id` и отдельный model selector, хранить выбранную пару в currentProfile/formProfile. Кнопки создания доступны при отсутствии старого аватара и voice setup. Для stop actions сначала local recording guard, затем await prepareSessionChange, потом IPC `{stopServices:true}`. Во время pending turn disconnect не отправляет отмену Бате: ответ сохраняется на сервере, history/conversationId остаются в профиле. Increment history/session generations перед закрытием, чтобы поздний loadHistory/delta/ASR не менял новую сессию. Dispose worker subscription и dialog handlers при unload, generation/root changes отключают неверные callbacks. Дополнить стили для карточек, компактного состояния/диалогов без перестройки разговорного экрана.
- [ ] **Step 5: GREEN и build.** Повторить шаг 2 и `npm run build` в desktop: тесты проходят, renderer собирается. Commit файлов задачи: `feat: add avatar creation and visual selection to Studio`.

### Task 7: Сквозная проверка, реальный GPU и документация

**Files:** Create `desktop/scripts/avatar-fixture-worker.mjs`; Modify `desktop/scripts/smoke-electron.mjs`, `desktop/electron/main.mjs` (fixture injection), `desktop/README.md`, `/home/kmrov/live/AGENTS.md`; при необходимости дополнить существующие тесты задач 1–6.

**Interfaces:**
- Consumes весь готовый feature, WorkerRequest/Event и bridge API.
- Produces fixture worker с исходником из временного fixture root: поддерживает controllable success/fail/delayed-cancel; создаёт только тестовые артефакты. Main использует его исключительно при существующем `LIVETALKING_DESKTOP_TEST_FIXTURE=1`, с новым `LIVETALKING_DESKTOP_TEST_AVATAR_ROOT` под временным test userData. В обычном режиме этот путь не используется. Для picker smoke подменяет main dialog через Playwright main-process evaluate, без нового свободного path IPC.

- [ ] **Step 1: Написать failing smoke-сценарий.** Во временном пустом каталоге открыть создание до voice setup; выбрать fixture photo, кириллическое имя и создать; наблюдать checking/running, пока диалог закрыт, reopen сохраняет progress. Успех публикует карточку; удалить первоначальный source и выбрать карточку. Перезапуск с тем же userData/root сохраняет имя/model/ID и миниатюру. Add existing avatar/rename/search, fail→retry, cancel→not selectable, close while generating→interrupted or cancelled without orphan. Проверить Escape и возврат focus. Review Focus: активная запись запрещает stop/select; завершить запись и выбрать другой тип → stopped services, saved pair, отдельный Start; pending delta прежней сессии не меняет новую карточку/историю.

Именованный `runAvatarCase` проверяет roundtrip карточки через новый Electron launch с тем же root/userData: `assert.equal(savedProfile.liveTalking.avatarId,createdId)`, `assert.equal(savedProfile.liveTalking.model,'musetalk')`, `assert.equal(await card.locator('[data-avatar-name]').textContent(),'Мой аватар')`, `assert.equal(await card.locator('img').evaluate(img => img.naturalWidth > 0),true)`. Карточки помечать `data-avatar-id`, имена `data-avatar-name`, этап `data-avatar-stage`; селекторы не зависят от CSS оформления.
- [ ] **Step 2: RED.** `npm run smoke` в desktop: новый сценарий падает на отсутствующих fixture injection/controls, существующие сценарии сохраняются.
- [ ] **Step 3: Реализовать fixture wiring и исправить выявленные дефекты.** Все источники, profiles, каталоги и рабочие записи fixture — во временных директориях. Fake event scheduling управляется тестом, без длинных sleep. Assertions проверяют мост и UI вместе; не добавлять production bypass trusted/validation. Сохранять скриншоты библиотеки/создания и журнал в desktop/test-results. Восстановление после аварийного закрытия проверять controlled child termination, не SIGKILL рабочему приложению пользователя.
- [ ] **Step 4: GREEN всей автоматической проверки.** В desktop: `npm test`, `npm run build`, `npm run smoke`. В корне: `.venv/bin/python -m unittest discover -s tests -p 'test_desktop*.py' -v` и `.venv/bin/python -m unittest discover -s tests -p 'test_start_qwen_avatar.py' -v`. Проверить свежие exit codes/output; failures диагностировать, не списывать на окружение без проверки. GPU не нужен этим тестам.
- [ ] **Step 5: Практическая проверка по доступному локальному окружению.** Сначала read-only проверить процессы/память GPU и веса, не останавливать чужие сервисы. На отдельных studio UUID создать MuseTalk photo, MuseTalk short video и Wav2Lip video, подключить каждый по WebRTC и озвучить текущим настроенным голосом; проверить cancel, restart и source independence. Если настоящая подготовка невозможна из-за внешних процессов/недостающих весов/дисплея, записать конкретную причину и отдельно отметить непроверенные сценарии. Не утверждать качество реального аватара по fixture.
- [ ] **Step 6: Обновить README/AGENTS и commit.** README: библиотека/создание, formats/models, source и work storage, остановка/cancel/retry, voice separately; удалить соответствующий future-work пункт. AGENTS: карта новых modules/worker/tests и актуальная инструкция выбора, без секретов/состояния процессов. AGENTS находится вне LiveTalking Git: сохранить правку отдельно и сообщить об этом в итоге. Commit перечисленных repo-файлов: `test: cover avatar creation and library lifecycle in Electron`.
- [ ] **Step 7: Проверить итоговый diff и завершить передачу.** По `verification-before-completion` подтвердить последние проверенные результаты. Обзор касается paths/IPC, ownership, публикации/восстановления, старых профилей и сохранения ответа Бати. Исправления после review проверяются относящимися к ним tests; без изменений повторять весь suite не требуется. Финальный отчёт: что теперь доступно, как открыть библиотеку/создание, выполненные tests и ограничения реальной GPU-проверки; интеграцию из изолированной копии выполнить по авторизации пользователя и `finishing-a-development-branch`.

## Самопроверка плана

- Задачи 1/6/7 реализуют библиотеку, названия, превью, существующие аватары и переименование.
- Задачи 2/3/4 реализуют первый аватар без разговорных сервисов, media normalization, source copy, прогресс/отмену и постоянные записи.
- Задачи 1/4 реализуют единую публикацию и восстановление при аварии, с сохранением данных и ограничением путей.
- Задачи 5/6 реализуют сериализацию, пару профиля, stop actions, запись/ASR/Батю и shutdown; все сигнатуры используют общие контракты.
- Каждый пункт Review Focus имеет конкретные failing assertions в указанной задаче; task 7 проверяет UX и процессы совместно.
- Не требуется новый UI framework, база, HTTP endpoint, очередь или система загрузки моделей. Продуктовые файлы до одобрения этого плана не изменяются.
