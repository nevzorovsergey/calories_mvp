import Link from "next/link";

/**
 * Постраничная навигация.
 *
 * Номера страниц целиком не раскладываем: у справочника их бывает под три
 * тысячи, и список ссылок был бы длиннее самой страницы. Соседние страницы плюс
 * счётчик «показано столько-то из стольких-то» отвечают на оба вопроса, ради
 * которых на пагинацию вообще смотрят: где я и много ли осталось.
 */
export default function Pager({
  basePath,
  query,
  page,
  pageSize,
  total,
  /** Общее число известно лишь снизу — счётчик тогда честно скажет «не меньше». */
  totalIsLowerBound = false,
}: {
  basePath: string;
  query: URLSearchParams;
  page: number;
  pageSize: number;
  total: number;
  totalIsLowerBound?: boolean;
}) {
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  const href = (target: number) => {
    const params = new URLSearchParams(query);
    if (target <= 1) params.delete("page");
    else params.set("page", String(target));
    const qs = params.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };

  return (
    <div className="mt-3 mb-6 flex items-center justify-between gap-3 text-caption">
      <p className="tnum text-ink-secondary">
        {total === 0
          ? "Ничего не нашлось"
          : `${first}–${last} из ${totalIsLowerBound ? "не менее " : ""}${total}`}
      </p>
      <div className="flex gap-2">
        {page > 1 && (
          <Link
            href={href(page - 1)}
            rel="prev"
            className="tap-target inline-flex items-center rounded-xl bg-card px-3 py-1.5 text-accent"
          >
            Назад
          </Link>
        )}
        {page < lastPage && (
          <Link
            href={href(page + 1)}
            rel="next"
            className="tap-target inline-flex items-center rounded-xl bg-card px-3 py-1.5 text-accent"
          >
            Дальше
          </Link>
        )}
      </div>
    </div>
  );
}
