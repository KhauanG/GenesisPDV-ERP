using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Threading;

namespace GenesisPDV.App.Comportamentos;

/// <summary>Toda tela/diálogo tem foco inicial definido (PDV 32.8): <c>Foco.Inicial="True"</c> no controle.</summary>
public static class Foco
{
    public static readonly AttachedProperty<bool> InicialProperty =
        AvaloniaProperty.RegisterAttached<InputElement, bool>("Inicial", typeof(Foco));

    static Foco()
    {
        InicialProperty.Changed.AddClassHandler<InputElement>((controle, e) =>
        {
            if (e.NewValue is true)
            {
                controle.AttachedToVisualTree += (_, _) => Focar(controle);
                if (controle.IsAttachedToVisualTree())
                {
                    Focar(controle);
                }
            }
        });
    }

    public static bool GetInicial(InputElement elemento) => elemento.GetValue(InicialProperty);

    public static void SetInicial(InputElement elemento, bool valor) => elemento.SetValue(InicialProperty, valor);

    public static void Focar(InputElement controle) => Dispatcher.UIThread.Post(() =>
    {
        controle.Focus();
        if (controle is TextBox caixa)
        {
            caixa.SelectAll();
        }
    }, DispatcherPriority.Loaded);

    private static bool IsAttachedToVisualTree(this Visual visual) => TopLevel.GetTopLevel(visual) is not null;
}
