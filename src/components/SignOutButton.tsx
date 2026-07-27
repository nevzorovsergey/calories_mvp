"use client";

import { useRouter } from "next/navigation";
import { Button } from "konsta/react";
import { createClient } from "@/lib/supabase/client";

export default function SignOutButton() {
  const router = useRouter();

  async function signOut() {
    await createClient().auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  return (
    <Button clear className="text-error" onClick={signOut}>
      Выйти
    </Button>
  );
}
