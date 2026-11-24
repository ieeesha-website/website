import { useState, useCallback } from "react";
import toast from "react-hot-toast";
import api from "../../../utils/api";

export function useToggleSubmissionAttendance(setSubmissions) {
  const [updatingIds, setUpdatingIds] = useState([]);

  const toggleAttendance = useCallback(
    async (submission) => {
      const id = submission?._id;
      if (!id) return;

      const previous = {
        attended: submission.attended,
        attendedAt: submission.attendedAt,
      };
      const attended = !previous.attended;

      // Optimistic: the badge changes on the very next render, and is rolled
      // back below if the server rejects the change.
      setSubmissions((prev) =>
        prev.map((item) =>
          item._id === id ? { ...item, attended } : item
        )
      );
      setUpdatingIds((prev) => [...prev, id]);

      try {
        const { data } = await api.put(`/submissions/${id}/attendance`, {
          attended,
        });
        const saved = data.submission || data;
        setSubmissions((prev) =>
          prev.map((item) =>
            item._id === id
              ? {
                  ...item,
                  attended: saved.attended,
                  attendedAt: saved.attendedAt,
                }
              : item
          )
        );
        toast.success(
          `Marked as ${attended ? "Attended" : "Not Attended"}`
        );
      } catch (err) {
        setSubmissions((prev) =>
          prev.map((item) => (item._id === id ? { ...item, ...previous } : item))
        );
        toast.error(
          err.response?.data?.message || "Failed to update attendance"
        );
      } finally {
        setUpdatingIds((prev) => prev.filter((item) => item !== id));
      }
    },
    [setSubmissions]
  );

  return { toggleAttendance, updatingIds };
}
