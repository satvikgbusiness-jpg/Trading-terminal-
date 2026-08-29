import { Panel } from '@/components/ui';

export const metadata = { title: 'DEMO CANVAS - GMT Terminal' };

const DEMO_URL = 'https://hrt4gjzrwr45k.kimi.page';

/**
 * The DEMO tab.
 *
 * An embedded third-party canvas, isolated in a sandboxed iframe. Nothing in the
 * terminal reads from it: no quote, no candle, no Outlook input, no paper fill.
 * It is here to be looked at, and it is labelled that way on every surface so a
 * screenshot of this page cannot be mistaken for live market data.
 */
export default function DemoPage() {
  return (
    <div className="flex flex-col gap-2 p-2">
      <div className="border border-term-warn/50 bg-term-warn/10 px-3 py-2">
        <p className="font-bold tracking-wide text-term-warn">
          DEMO CANVAS - SYNTHETIC DATA, NOT LIVE
        </p>
        <p className="mt-1 text-term-text">
          This is an embedded third-party page shown for demonstration only. The numbers in it are
          synthetic. Nothing here feeds quotes, charts, the Outlook engine, the sentiment model, or
          the paper ledger, and no value shown below is used anywhere else in this terminal.
        </p>
      </div>

      <Panel
        title="Embedded demo canvas"
        right={<span className="text-term-faint">{DEMO_URL}</span>}
      >
        <iframe
          src={DEMO_URL}
          title="Demo canvas (synthetic data)"
          className="h-[75vh] w-full border-0 bg-white"
          /* Third-party content: no same-origin access, no top-level navigation,
             no popups, no form submission. It can run scripts and nothing else. */
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          loading="lazy"
        />
      </Panel>

      <p className="px-1 text-2xs text-term-faint">
        Embedded in a sandboxed iframe with no same-origin access and no navigation rights. If the
        frame is blank, the remote page declined to be embedded -- open it directly instead.
      </p>
    </div>
  );
}
