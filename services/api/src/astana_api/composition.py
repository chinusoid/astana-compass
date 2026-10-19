"""Only this module loads team implementations; missing live adapters fail closed."""
from dataclasses import dataclass
from importlib import import_module
from inspect import Parameter, isasyncgenfunction, isawaitable, iscoroutinefunction, signature
from contextlib import AsyncExitStack

from astana_contracts import ContextProvider, PlaceRepository, RecommendationService, Retriever
from astana_recommender import DefaultRecommendationService, ExplanationGenerator
from .fixtures import FixtureRepository, FixtureRetriever, FixtureContext


@dataclass
class Services:
    repository: object
    recommender: object
    intent: object | None = None


def resolve(path):
    module, separator, name = path.partition(":")
    if not separator or not module or not name:
        raise ValueError("Factory must use module:function syntax")
    factory = getattr(import_module(module), name)
    if not callable(factory):
        raise ValueError("Adapter factory must be callable")
    return factory


async def own(stack: AsyncExitStack, resource):
    if isawaitable(resource):
        resource = await resource
    if callable(getattr(resource, "aclose", None)):
        stack.push_async_callback(resource.aclose)
    elif callable(getattr(resource, "close", None)):
        stack.callback(resource.close)
    return resource


def validate_port(resource, protocol):
    """Check required call shapes without invoking an adapter or accessing the network.

    A plain function can correctly return an awaitable, so iscoroutinefunction
    alone must not reject compatible wrappers, callable objects or native clients.
    Unknown signatures are allowed; result/awaitability checks still occur at the
    runtime boundary. An async generator is not an awaitable port implementation.
    """
    for name, declared in vars(protocol).items():
        if name.startswith("_") or not iscoroutinefunction(declared):
            continue
        message = f"Configured adapter must implement the {protocol.__name__}.{name} async port."
        try:
            method = getattr(resource, name)
        except Exception:
            raise ValueError(message) from None
        if not callable(method) or isasyncgenfunction(method):
            raise ValueError(message)
        try:
            actual = signature(method)
        except (TypeError, ValueError):
            # Some otherwise-compatible native/proxy callables have no signature.
            continue
        except Exception:
            raise ValueError(message) from None
        expected = signature(declared)
        for include_optional in (False, True):
            args, kwargs = [], {}
            for parameter in expected.parameters.values():
                if parameter.name == "self":
                    continue
                if parameter.default is not Parameter.empty and not include_optional:
                    continue
                if parameter.kind in (Parameter.POSITIONAL_ONLY, Parameter.POSITIONAL_OR_KEYWORD):
                    args.append(None)
                elif parameter.kind is Parameter.KEYWORD_ONLY:
                    kwargs[parameter.name] = None
            try:
                actual.bind(*args, **kwargs)
            except TypeError:
                raise ValueError(message) from None


async def build_services(settings, stack):
    # Failed startup must close partially-created clients immediately, rather than
    # leave them owned by the still-running liveness-only application.
    async with AsyncExitStack() as owned:
        # Config contains no secrets; each server-side adapter reads its documented env.
        config = {"timezone": "Asia/Almaty", "mode": settings.mode}
        if settings.mode == "fixture":
            repository = FixtureRepository()
        else:
            repository = await own(owned, resolve(settings.repository_factory)(config=config))
        validate_port(repository, PlaceRepository)
        if settings.mode == "fixture":
            retriever = FixtureRetriever(repository)
        else:
            retriever = await own(
                owned, resolve(settings.retriever_factory)(repository=repository, config=config)
            )
        validate_port(retriever, Retriever)
        if settings.mode == "fixture":
            context = FixtureContext()
        else:
            context = await own(owned, resolve(settings.context_factory)(config=config))
        validate_port(context, ContextProvider)
        generator = None
        llm_budget = None
        if settings.llm_provider != "none":
            from astana_ai_providers import create_generator
            from astana_ai_providers.budgets import RequestBudget
            # One allowance covers all intent and explanation calls in this API
            # process. Multi-worker deployments also need a shared edge quota.
            llm_budget = RequestBudget.from_env()
            generator = await own(
                owned, create_generator(
                    provider=settings.llm_provider, model=settings.llm_model, api_key=settings.llm_api_key,
                    budget=llm_budget,
                )
            )
            validate_port(generator, ExplanationGenerator)
        recommender = DefaultRecommendationService(repository, retriever, context, generator=generator)
        validate_port(recommender, RecommendationService)
        from astana_ai_providers.intents import create_intent_analyzer
        intent = await own(owned, create_intent_analyzer(
            provider=settings.llm_provider if settings.llm_provider != "none" else "rules",
            model=settings.llm_model or None, api_key=settings.llm_api_key or None,
            budget=llm_budget,
        ))
        services = Services(repository=repository, recommender=recommender, intent=intent)
        stack.push_async_callback(owned.pop_all().aclose)
        return services
