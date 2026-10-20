import { useEffect, useState } from "react";
import type { NoteEvent } from "@tabsify/engine";

interface NoteFieldProps {
  note: NoteEvent;
  onFretChange: (id: string, fret: number) => void;
  onMoveString: (id: string, delta: number) => void;
  onDelete: (id: string) => void;
  onSelectRelative: (id: string, delta: number) => void;
}

/** Input fret inline yang dipakai editor grid maupun notasi. */
export function NoteField({
  note,
  onFretChange,
  onMoveString,
  onDelete,
  onSelectRelative,
}: NoteFieldProps) {
  const [value, setValue] = useState(String(note.fret ?? 0));

  useEffect(() => {
    setValue(String(note.fret ?? 0));
  }, [note.id, note.fret]);

  const commit = (raw: string) => {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed !== note.fret) {
      onFretChange(note.id, parsed);
    }
  };

  return (
    <input
      className="fret-input"
      inputMode="numeric"
      autoFocus
      value={value}
      onChange={(event) => setValue(event.target.value.replace(/[^0-9]/g, "").slice(0, 2))}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={() => commit(value)}
      onKeyDown={(event) => {
        const target = event.currentTarget;
        switch (event.key) {
          case "Enter":
            event.preventDefault();
            commit(value);
            target.blur();
            break;
          case "Escape":
            event.preventDefault();
            setValue(String(note.fret ?? 0));
            target.blur();
            break;
          case "ArrowUp":
            event.preventDefault();
            commit(value);
            onMoveString(note.id, 1);
            break;
          case "ArrowDown":
            event.preventDefault();
            commit(value);
            onMoveString(note.id, -1);
            break;
          case "ArrowLeft":
            event.preventDefault();
            onSelectRelative(note.id, -1);
            break;
          case "ArrowRight":
          case "Tab":
            event.preventDefault();
            onSelectRelative(note.id, 1);
            break;
          case "Delete":
          case "Backspace":
            event.preventDefault();
            onDelete(note.id);
            break;
          default:
            break;
        }
      }}
    />
  );
}
