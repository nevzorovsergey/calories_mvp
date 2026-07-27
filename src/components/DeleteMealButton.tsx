"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Dialog, DialogButton } from "konsta/react";

/** FR-DET-5. Удаление необратимо, поэтому спрашиваем подтверждение. */
export default function DeleteMealButton({ mealId }: { mealId: string }) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function remove() {
    setDeleting(true);
    const response = await fetch(`/api/meals/${mealId}`, { method: "DELETE" });
    setDeleting(false);
    setAsking(false);
    if (response.ok) {
      router.push("/today");
      router.refresh();
    }
  }

  return (
    <>
      <Button
        clear
        className="text-error"
        onClick={() => setAsking(true)}
        disabled={deleting}
      >
        Удалить приём пищи
      </Button>

      <Dialog
        opened={asking}
        onBackdropClick={() => setAsking(false)}
        title="Удалить приём пищи?"
        content="Фотография, результат модели и ваша версия состава будут удалены безвозвратно."
        buttons={
          <>
            <DialogButton onClick={() => setAsking(false)}>Отмена</DialogButton>
            <DialogButton strong onClick={remove}>
              Удалить
            </DialogButton>
          </>
        }
      />
    </>
  );
}
