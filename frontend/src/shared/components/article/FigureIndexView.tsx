import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { useEffect, useState } from 'react';

interface FigureEntry {
  number: number;
  caption: string;
}

export function FigureIndexView({ editor }: NodeViewProps) {
  const [entries, setEntries] = useState<FigureEntry[]>([]);

  useEffect(() => {
    const update = () => {
      const figures: FigureEntry[] = [];
      let count = 0;
      editor.state.doc.descendants((node) => {
        if (node.type.name === 'figure') {
          count++;
          const caption = node.content.lastChild?.textContent || '';
          figures.push({ number: count, caption });
        }
      });
      setEntries(figures);
    };
    update();
    editor.on('update', update);
    return () => {
      editor.off('update', update);
    };
  }, [editor]);

  return (
    <NodeViewWrapper
      className="figure-index my-4 p-4 border border-border rounded-lg"
      contentEditable={false}
    >
      <h3 className="text-sm font-semibold mb-2">List of Figures</h3>
      {entries.length > 0 ? (
        <ol className="list-decimal pl-6 text-sm space-y-1">
          {entries.map((e) => (
            <li key={e.number}>
              Figure {e.number}: {e.caption || <em className="text-muted-foreground">No caption</em>}
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-muted-foreground italic">No figures in this document</p>
      )}
    </NodeViewWrapper>
  );
}
