import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { useEffect, useRef, useState } from 'react';

interface TableEntry {
  number: number;
  caption: string;
}

export function TableIndexView({ editor }: NodeViewProps) {
  const [entries, setEntries] = useState<TableEntry[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const scan = () => {
      const tables: TableEntry[] = [];
      let count = 0;
      editor.state.doc.descendants((node) => {
        if (node.type.name === 'tableCaption') {
          count++;
          tables.push({ number: count, caption: node.textContent });
        }
      });
      setEntries(tables);
    };
    const update = () => {
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(scan, 250);
    };
    scan();
    editor.on('update', update);
    return () => {
      clearTimeout(timerRef.current);
      editor.off('update', update);
    };
  }, [editor]);

  return (
    <NodeViewWrapper
      className="table-index my-4 p-4 border border-border rounded-lg"
      contentEditable={false}
    >
      <h3 className="text-sm font-semibold mb-2">List of Tables</h3>
      {entries.length > 0 ? (
        <ol className="list-decimal pl-6 text-sm space-y-1">
          {entries.map((e) => (
            <li key={e.number}>
              Table {e.number}: {e.caption || <em className="text-muted-foreground">No caption</em>}
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-muted-foreground italic">No tables with captions in this document</p>
      )}
    </NodeViewWrapper>
  );
}
