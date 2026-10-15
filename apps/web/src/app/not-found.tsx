import Link from "next/link";
import { SearchX } from "lucide-react";

import { Button } from "@/components/ui/button";
import { StatePanel } from "@/components/states/state-panel";

export default function NotFound() {
  return (
    <StatePanel
      icon={<SearchX className="size-5" />}
      title="Page not found"
      description="That route does not exist. It may have been renamed, or the link may be mistyped."
      action={
        <Button variant="outline" size="sm" asChild>
          <Link href="/">Back to overview</Link>
        </Button>
      }
    />
  );
}
