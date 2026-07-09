import { DemoExploringBanner } from "./InstallNudge.tsx";
import { TodoCarousel } from "./TodoCarousel.tsx";
import type { Todo, TodoId } from "./types.ts";

type SetupTodosViewProps =
  | {
      showDemoExploringBanner: true;
      stopExploring: () => void;
    }
  | {
      showDemoExploringBanner: false;
      todos: Todo[];
      busyId: TodoId | null;
      total: number;
      completed: number;
      onAction: (todo: Todo) => void;
    };

export function SetupTodosView(props: SetupTodosViewProps) {
  if (props.showDemoExploringBanner) {
    return <DemoExploringBanner onConnect={props.stopExploring} />;
  }

  return (
    <TodoCarousel
      todos={props.todos}
      busyId={props.busyId}
      total={props.total}
      completed={props.completed}
      onAction={props.onAction}
    />
  );
}
