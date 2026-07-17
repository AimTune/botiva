namespace Botiva.Agents;

/// <summary>
/// Thrown by <see cref="Hitl.Interrupt"/> on the first pass through a tool —
/// the runtime turns it into a botiva interrupt event (approval chips in the
/// client) and pauses the run. Not an error.
/// </summary>
public sealed class BotivaInterruptException(object? payload) : Exception("botiva interrupt (waiting for user input)")
{
    public object? Payload { get; } = payload;
}

/// <summary>
/// LangGraph-style interrupt() for .NET tools (PROTOCOL.md §5).
///
/// First pass: throws <see cref="BotivaInterruptException"/> — the engine
/// stores the pending interrupt and the client shows chips. The user's next
/// message re-runs the SAME tool call with the answer injected, so the second
/// pass returns it:
///
///   [Description("Generates a report PDF (asks the user for approval first).")]
///   static string GenerateReportPdf(string topic)
///   {
///       var answer = (string?)Hitl.Interrupt(new { question = $"Generate \"{topic}\"?", options = new[] { "Approve", "Cancel" } });
///       if (!Regex.IsMatch(answer ?? "", "approve|yes|onay|evet", RegexOptions.IgnoreCase))
///           return "The user declined — no report was generated.";
///       return $"Report ready: report-{topic}.pdf";
///   }
/// </summary>
public static class Hitl
{
    private static readonly AsyncLocal<object?> Resume = new();

    /// <summary>
    /// Pause for user input. Returns the user's answer on the resume pass;
    /// throws <see cref="BotivaInterruptException"/> on the first pass.
    /// Recommended payload: <c>{ question, options }</c> → rendered as chips.
    /// </summary>
    public static object? Interrupt(object? payload)
    {
        if (Resume.Value is { } answer)
        {
            Resume.Value = null; // one-shot: a second Interrupt in the same run pauses again
            return answer;
        }
        throw new BotivaInterruptException(payload);
    }

    /// <summary>Runtime hook: make <paramref name="value"/> available to the next Interrupt call downstream.</summary>
    internal static void SetResume(object? value) => Resume.Value = value;
}
