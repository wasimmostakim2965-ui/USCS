import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import DashboardHome from "@/pages/DashboardHome";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home, { AuthCallback } from "./pages/Home";
import { dashboardRoutes } from "./pages/dashboard/navigation";

function Router() {
  return (
    <Switch>
      <Route path={"/auth/callback"} component={AuthCallback} />
      <Route path={"/"} component={Home} />
      <Route path={"/dashboard"} component={DashboardHome} />
      {dashboardRoutes.map(path => <Route key={path} path={path} component={DashboardHome} />)}
      <Route path={"/dashboard/:rest*"} component={DashboardHome} />
      <Route path={"/404"} component={NotFound} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
