import { redirect } from "next/navigation";
import { Hexagon } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { LoginForm } from "@/app/login/login-form";
import { getSession } from "@/lib/auth/session";
import { safeNext } from "@/lib/auth/next-path";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const session = await getSession();
  if (session) redirect("/");

  const params = await searchParams;

  return (
    <div className="flex min-h-[80vh] items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="space-y-2">
          <span
            aria-hidden="true"
            className="grid size-9 place-items-center rounded-md bg-primary text-primary-foreground"
          >
            <Hexagon className="size-5" />
          </span>
          <CardTitle className="text-xl">Sign in to Hextrail</CardTitle>
          <CardDescription>
            Your traces are private to your account.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <LoginForm next={safeNext(params.next)} />
        </CardContent>
      </Card>
    </div>
  );
}
