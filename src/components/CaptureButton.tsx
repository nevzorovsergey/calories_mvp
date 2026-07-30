"use client";

/* eslint-disable @next/next/no-img-element */

import { useRef, useState, type RefObject } from "react";
import { useRouter } from "next/navigation";
import { Camera, CreditCard } from "lucide-react";
import {
  Actions,
  ActionsButton,
  ActionsGroup,
  ActionsLabel,
  Button,
  Fab,
  Popup,
  Preloader,
} from "konsta/react";
import { preparePhoto, type PreparedPhoto } from "@/lib/image";
import { formatMealDate } from "@/lib/format";

interface MealResponse {
  meal_id?: string;
  status?: string;
  error?: string;
}

/**
 * Сколько ждём хоть какого-то движения байтов, прежде чем признать отправку
 * зависшей. Диагностика 2026-07-28 показала, что тело запроса умеет молча
 * замирать на середине: preflight проходит, а дальше тишина. Без сторожа это
 * выглядит как вечный спиннер — ровно та жалоба, с которой всё началось.
 */
const STALL_MS = 20_000;

/** Потолок на всю отправку целиком, включая ответ сервера. */
const CEILING_MS = 120_000;

interface UploadOutcome {
  status: number;
  text: string;
}

/**
 * Отправка через XMLHttpRequest, а не fetch: fetch не отдаёт прогресс
 * отправки, а на медленном мобильном канале разница между «идёт, 40%» и
 * «встало» — это и есть вся полезная информация.
 */
function sendPhoto(
  form: FormData,
  onProgress: (percent: number) => void,
  register: (xhr: XMLHttpRequest) => void,
): Promise<UploadOutcome> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    register(xhr);

    let stall: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(stall);
      stall = setTimeout(() => {
        xhr.abort();
        reject(new Error("связь пропала на середине отправки"));
      }, STALL_MS);
    };
    const disarm = () => clearTimeout(stall);

    xhr.upload.addEventListener("progress", (event) => {
      arm();
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    });
    // Тело ушло целиком: дальше сервер кладёт кадры в Storage и заводит приём
    // пищи, событий прогресса больше не будет — сторож простоя тут только
    // помешает, за эту фазу отвечает общий потолок.
    xhr.upload.addEventListener("load", () => {
      disarm();
      onProgress(100);
    });

    xhr.addEventListener("load", () => {
      disarm();
      resolve({ status: xhr.status, text: xhr.responseText });
    });
    xhr.addEventListener("error", () => {
      disarm();
      reject(new Error("сеть недоступна"));
    });
    xhr.addEventListener("abort", disarm);
    xhr.addEventListener("timeout", () => {
      disarm();
      reject(new Error(`сервер не ответил за ${Math.round(CEILING_MS / 1000)} с`));
    });

    xhr.timeout = CEILING_MS;
    xhr.open("POST", "/api/meals");
    arm();
    xhr.send(form);
  });
}

/**
 * Ошибки платформы (413 на большом теле, 504 на долгом ответе) приходят
 * HTML-страницей, а не JSON. Без этой обёртки разбор падал, и Safari показывал
 * пользователю «The string did not match the expected pattern».
 */
function readJson({ status, text }: UploadOutcome): MealResponse {
  try {
    return JSON.parse(text) as MealResponse;
  } catch {
    if (status === 413) throw new Error("фото слишком большое для сервера");
    if (status === 504) throw new Error("сервер не ответил вовремя (504)");
    throw new Error(`сервер вернул ${status} без JSON`);
  }
}

/**
 * Съёмка (§11.3).
 *
 * Тап → выбор источника: камера устройства или галерея (FR-CAP-1). Источника
 * два, потому что одним инпутом их не покрыть: `capture="environment"` в
 * Safari iOS и Chrome Android открывает камеру сразу, не оставляя пути к уже
 * снятым фотографиям, а без него камеру ещё надо найти в системном меню. Так
 * что камера и галерея — два разных скрытых `input[type=file]`.
 *
 * Дальше предпросмотр с необязательной подсказкой и ненавязчивым советом
 * положить в кадр банковскую карту — именно карту, а не монету: её размер
 * стандартизирован ISO и одинаков во всём мире, тогда как монету модель должна
 * сначала опознать по стране и номиналу (§7.5.3).
 *
 * Пользователь ждёт только отправку фотографии. Распознавание идёт на сервере
 * и переживает закрытие экрана (§5.1), поэтому здесь нет и не должно быть
 * ожидания модели — только загрузка с честными процентами.
 *
 * FR-CAP-8: если открыт не сегодняшний день, перед предпросмотром спрашиваем
 * дату. Листать дни назад нужно, чтобы дописать пропущенное, но выйти оттуда
 * легко забыть — и свежий обед молча уезжает в чужие итоги. Вопрос задаётся
 * только вне сегодняшнего дня: в обычном случае лишнего шага нет.
 */
export default function CaptureButton({
  mealDate,
  today,
}: {
  mealDate: string;
  today: string;
}) {
  const router = useRouter();
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef<XMLHttpRequest | null>(null);
  const [sourcePicker, setSourcePicker] = useState(false);
  const [photo, setPhoto] = useState<PreparedPhoto | null>(null);
  const [hint, setHint] = useState("");
  const [phase, setPhase] = useState<"idle" | "date" | "preview" | "sending">("idle");
  const [date, setDate] = useState(mealDate);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  /** Вне сегодняшнего дня дата — не очевидность, а выбор, который надо подтвердить. */
  const asksDate = mealDate !== today;

  async function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ""; // чтобы повторный выбор того же файла сработал
    if (!file) return;
    setError(null);
    try {
      const result = await preparePhoto(file);
      setPhoto(result);
      setPhase(asksDate ? "date" : "preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Клик по инпуту делаем синхронно внутри обработчика: Safari открывает
   * файловый диалог только по живому пользовательскому жесту, после await
   * молча ничего не происходит.
   */
  function pickFrom(ref: RefObject<HTMLInputElement | null>) {
    setSourcePicker(false);
    ref.current?.click();
  }

  function reset() {
    requestRef.current?.abort();
    requestRef.current = null;
    if (photo) URL.revokeObjectURL(photo.previewUrl);
    setPhoto(null);
    setHint("");
    setProgress(0);
    setDate(mealDate);
    setPhase("idle");
  }

  /** Ответ на вопрос о дате: выбранный день запоминаем и идём к предпросмотру. */
  function chooseDate(value: string) {
    setDate(value);
    setPhase("preview");
  }

  async function submit() {
    if (!photo) return;
    setPhase("sending");
    setProgress(0);
    setError(null);

    try {
      const form = new FormData();
      form.append("sent", photo.sent.blob, "sent.jpg");
      if (photo.archive) {
        form.append("archive", photo.archive.blob, "archive.jpg");
      }
      form.append("meal_date", date);
      form.append("photo_width", String(photo.sent.width));
      form.append("photo_height", String(photo.sent.height));
      if (hint.trim()) form.append("user_hint", hint.trim());

      const outcome = await sendPhoto(form, setProgress, (xhr) => {
        requestRef.current = xhr;
      });
      requestRef.current = null;
      const data = readJson(outcome);

      if (outcome.status < 200 || outcome.status >= 300) {
        throw new Error(data.error ?? `Ошибка сервера (${outcome.status})`);
      }

      // Фотография принята. Распознавание уже идёт на сервере — экран приёма
      // пищи покажет его ход и не требует, чтобы страница оставалась открытой.
      reset();
      router.push(`/meal/${data.meal_id}`);
    } catch (err) {
      requestRef.current = null;
      setPhase("preview");
      setProgress(0);
      setError(
        err instanceof Error
          ? `Не удалось отправить фото: ${err.message}`
          : String(err),
      );
    }
  }

  return (
    <>
      <input
        ref={cameraRef}
        data-source="camera"
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleFile}
        className="hidden"
      />
      <input
        ref={galleryRef}
        data-source="gallery"
        type="file"
        accept="image/*"
        onChange={handleFile}
        className="hidden"
      />

      <Fab
        className="fixed right-4 bottom-24 z-20"
        icon={<Camera size={24} />}
        text="Добавить фото"
        onClick={() => setSourcePicker(true)}
      />

      <Actions
        opened={sourcePicker}
        onBackdropClick={() => setSourcePicker(false)}
      >
        <ActionsGroup>
          <ActionsLabel>Фото блюда</ActionsLabel>
          <ActionsButton bold onClick={() => pickFrom(cameraRef)}>
            Сделать фото
          </ActionsButton>
          <ActionsButton onClick={() => pickFrom(galleryRef)}>
            Выбрать из галереи
          </ActionsButton>
          {/* Путь без фотографии живёт здесь же, а не отдельной кнопкой на
              экране: выбор «как добавить еду» человек делает один раз и в одном
              месте, а вторая плавающая кнопка спорила бы с первой за внимание. */}
          <ActionsButton
            onClick={() => {
              setSourcePicker(false);
              router.push(`/add?date=${mealDate}`);
            }}
          >
            Найти в справочнике
          </ActionsButton>
        </ActionsGroup>
        <ActionsGroup>
          <ActionsButton bold onClick={() => setSourcePicker(false)}>
            Отмена
          </ActionsButton>
        </ActionsGroup>
      </Actions>

      <Popup
        opened={phase !== "idle"}
        onBackdropClick={() =>
          (phase === "preview" || phase === "date") && reset()
        }
      >
        <div className="mx-auto flex h-full max-w-screen-sm flex-col overflow-y-auto p-4">
          {phase === "date" ? (
            <>
              <h2 className="mb-1 text-section font-semibold">К какому дню отнести?</h2>
              <p className="mb-4 text-caption text-ink-secondary">
                Открыт день «{formatMealDate(mealDate, today)}», а не сегодняшний.
                Блюдо попадёт в итоги того дня, который вы выберете.
              </p>

              <div className="mb-5 flex flex-col gap-2">
                <Button onClick={() => chooseDate(mealDate)} className="tap-target">
                  Да, к «{formatMealDate(mealDate, today)}»
                </Button>
                <Button outline onClick={() => chooseDate(today)} className="tap-target">
                  Нет, я съел это сегодня
                </Button>
              </div>

              <label
                className="mb-1 block text-caption text-ink-secondary"
                htmlFor="capture-date"
              >
                Или выберите другую дату
              </label>
              <input
                id="capture-date"
                type="date"
                value={date}
                max={today}
                onChange={(event) => setDate(event.target.value)}
                className="mb-2 w-full rounded-xl bg-card p-3 text-body"
              />
              <Button
                outline
                onClick={() => chooseDate(date)}
                disabled={!date}
                className="tap-target"
              >
                Отнести к выбранной дате
              </Button>

              <div className="mt-4">
                <Button clear onClick={reset} className="tap-target">
                  Отмена
                </Button>
              </div>
            </>
          ) : (
            <>
              <h2 className="mb-3 text-section font-semibold">Проверьте кадр</h2>

              {/* Дата видна и на предпросмотре: вопрос задан раньше, но отправлять
                  вслепую человек не должен — ответ всегда можно поправить. */}
              {asksDate && (
                <div className="mb-3 flex items-center justify-between gap-2 rounded-xl bg-card p-3 text-caption">
                  <span>
                    День приёма пищи:{" "}
                    <span className="font-medium">{formatMealDate(date, today)}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setPhase("date")}
                    disabled={phase === "sending"}
                    className="shrink-0 text-accent"
                  >
                    Изменить
                  </button>
                </div>
              )}

              {photo && (
                <img
                  src={photo.previewUrl}
                  alt="Предпросмотр снимка"
                  className="mb-3 w-full rounded-2xl object-cover"
                />
              )}

              <div className="mb-3 flex items-start gap-2 rounded-xl bg-card p-3 text-caption text-ink-secondary">
                <CreditCard size={18} className="mt-0.5 shrink-0 text-accent" />
                <span>
                  Положите рядом банковскую карту — оценка веса будет точнее. Её
                  размер одинаков во всём мире, поэтому это самый надёжный эталон.
                </span>
              </div>

              <label className="mb-1 block text-caption text-ink-secondary" htmlFor="hint">
                Подсказка (что это, как готовили) — необязательно
              </label>
              <textarea
                id="hint"
                value={hint}
                onChange={(e) => setHint(e.target.value)}
                rows={2}
                disabled={phase === "sending"}
                placeholder="Например: гречка с куриной грудкой, жарил на подсолнечном масле"
                className="mb-4 w-full rounded-xl bg-card p-3 text-body"
              />

              {error && (
                <p className="mb-3 text-caption text-error" role="alert">
                  {error}
                </p>
              )}

              {phase === "sending" ? (
                <div className="flex flex-col items-center gap-2 py-4 text-center">
                  <Preloader />
                  {/* FR-CAP-5: показываем ровно тот шаг, который идёт сейчас.
                      Раньше здесь висело «Распознаём моделью …» с самого начала —
                      и когда вставала отправка, надпись уводила в сторону модели,
                      которую ещё даже не вызывали. */}
                  {progress < 100 ? (
                    <>
                      <p className="text-body" role="status">
                        Отправляем фото… {progress}%
                      </p>
                      <p className="text-caption text-ink-secondary">
                        Не закрывайте экран, пока фото не уйдёт.
                      </p>
                    </>
                  ) : (
                    <p className="text-body" role="status">
                      Сохраняем…
                    </p>
                  )}
                </div>
              ) : (
                <div className="flex gap-2">
                  <Button outline onClick={reset} className="tap-target">
                    Отмена
                  </Button>
                  <Button onClick={submit} className="tap-target">
                    Отправить
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </Popup>
    </>
  );
}
