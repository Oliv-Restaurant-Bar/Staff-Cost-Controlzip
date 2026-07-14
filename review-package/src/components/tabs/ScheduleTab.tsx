import { EmbeddedSchedulePlanner } from '@/components/EmbeddedSchedulePlanner';

interface ScheduleTabProps {
  selectedDate: Date;
}

export const ScheduleTab = ({ selectedDate }: ScheduleTabProps) => {
  return (
    <div className="space-y-6">
      <EmbeddedSchedulePlanner selectedDate={selectedDate} />
    </div>
  );
};
