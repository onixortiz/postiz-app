'use client';

import { FC, useState } from 'react';
import { Button } from '@gitroom/react/form/button';
import { useT } from '@gitroom/react/translation/get.transation.service.client';

// FORK: approvals. One text field: the one line topic when a batch is sent
// without brief, and the comment or reason the other actions ask for.
export const TextPromptModal: FC<{
  label: string;
  placeholder?: string;
  submitLabel: string;
  minLength: number;
  maxLength: number;
  multiline?: boolean;
  onSubmit: (value: string) => Promise<boolean>;
  close: () => void;
}> = (props) => {
  const t = useT();
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(false);
  const length = value.trim().length;
  const valid = length >= props.minLength && length <= props.maxLength;

  const submit = async () => {
    if (!valid || loading) {
      return;
    }
    setLoading(true);
    const done = await props.onSubmit(value.trim());
    setLoading(false);
    if (done) {
      props.close();
    }
  };

  const className =
    'w-full rounded-[8px] bg-newBgColor border border-newBorder px-[12px] py-[10px] text-[14px] outline-none';

  return (
    <div className="flex flex-col gap-[12px] p-[16px] pt-0 min-w-[320px]">
      <div className="text-[14px] font-[600]">{props.label}</div>
      {props.multiline ? (
        <textarea
          autoFocus
          rows={4}
          maxLength={props.maxLength}
          value={value}
          placeholder={props.placeholder}
          onChange={(e) => setValue(e.target.value)}
          className={className}
        />
      ) : (
        <input
          autoFocus
          maxLength={props.maxLength}
          value={value}
          placeholder={props.placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          className={className}
        />
      )}
      {length > 0 && length < props.minLength && (
        <div className="text-[12px] text-red-400">
          {t('approvals_min_characters', 'At least {{count}} characters', {
            count: props.minLength,
          })}
        </div>
      )}
      <Button disabled={!valid} loading={loading} onClick={submit}>
        {props.submitLabel}
      </Button>
    </div>
  );
};
