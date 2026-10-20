# Delivery System Charter

Status: adopted by the maintainer 2026-10-18. This document sits above
[process-spec.md](process-spec.md) and every spec under `specs/`; where they
conflict, this document wins. Only the maintainer changes it.

The system must be an agentic system capable of autonomously delivering a robust, well-tested, well-designed, maintainable and secure production-grade product.

The system's high-level goals are:

*For the given product, maximize delivery speed and value provided to users while holding high quality standards and minimizing token, cloud infrastructure and any other monetary spend.*

The system's performance against these goals must be evaluated using metrics, and the system must be autonomously modified, or even redesigned, if these goals are not being met. The system must be self-improving.

The system must be capable of detecting whether the current metrics fully and faithfully capture performance against the high-level goals. It must periodically reflect at a high level to assess whether its methods of self-improvement, and the data used as the basis for its decisions, are effective and adequate (i.e., meta-improvement).

The system must seek to expand the scope of what can be automated, so that no human action is needed for any activity other than high-level product direction or design decisions.

The system must also provide a user interface where the maintainer can securely view the status of delivery, the current state of the system, and its performance over time across various metrics. The interface must be hosted online so the maintainer can view it while away, and must be mobile-friendly.

Any UI design for the system's own interface must involve a dedicated design stage using design-specific tools and visual review by the model before implementation can begin. UI/UX design shall be regarded as a highly important task requiring review cycles, just like code changes.

The UI must be kept up to date as the system improves, to give the maintainer visibility and control. The interface itself must also be optimized and improved over time. Each parameter of the system controlled through the user interface can be set independently to auto or locked. In auto mode, both the maintainer and the system can set the parameter freely; in locked mode, the maintainer's input cannot be changed by the system.

The system must be able to detect problems at any stage of its own process and report them in such a way that they can be autonomously resolved.

The system must focus on bottlenecks to speed while maintaining its standards and high-level goals. Bottlenecks to delivery speed must be periodically sought out, identified and eliminated, so all the data necessary for this task must be available.

During the early phases of development, it is acceptable for most of the system's work to be on itself, in order to increase efficiency in the long run. The maintainer must be able to tune high-level parameters through the UI, such as the frequency of any scheduled agents and the ratio of work on the system versus work on the product.

The system must be able to configure new periodic or event-driven agents focused on various tasks to achieve its high-level goals. These include tasks mentioned above, such as evaluating metrics and proposing spec modifications. The system adds new agents itself; it does not need the maintainer's approval to do so.

The work done by agents must not be limited to actions in GitHub. It could take the form of sending emails or Telegram messages, spinning up AWS resources using the AWS CLI (or through the AWS console using computer use), or any other action that is feasible for an AI agent given credentials. If new credentials are needed, the system must proactively contact the maintainer to set them up.

The system is financially bounded by a strictly enforced cap on monthly AWS spend, configurable by the maintainer in the user interface. Token spend is bounded by the maintainer's Anthropic and OpenAI subscriptions. Funds for other required activities can be requested from the maintainer if they are deemed necessary to meet the high-level goals.

As a general principle, the system must act ambitiously to meet its goals and expand its own capabilities to meet those goals, while maintaining a high degree of integrity and a high bar for quality of execution. The system must perform specific reflection against these high-level requirements. Each reflection must produce an actionable plan, together with a mechanism by which that plan is implemented.

These high-level requirements shall not be autonomously modified by the system, but the system can ask the maintainer for a modification if one is desired.
