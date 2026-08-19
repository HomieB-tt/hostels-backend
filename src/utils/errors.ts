export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const Errors = {
  bedUnavailable: () =>
    new ApiError(409, "BED_UNAVAILABLE", "This bed is not available for the requested period."),
  bookingNotFound: () =>
    new ApiError(404, "BOOKING_NOT_FOUND", "Booking not found."),
  notPendingPayment: () =>
    new ApiError(409, "INVALID_STATE", "Booking is not in PENDING_PAYMENT state."),
};
