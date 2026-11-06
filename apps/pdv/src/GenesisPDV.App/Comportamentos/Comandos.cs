using System.Windows.Input;
using Avalonia;
using Avalonia.Input;

namespace GenesisPDV.App.Comportamentos;

/// <summary>
/// Mouse nas listas (decisão 65): <c>c:Comandos.DuploClique="{Binding Comando}"</c> executa o comando no duplo clique,
/// com o modelo da linha clicada (o <c>DataContext</c> do elemento sob o ponteiro) como parâmetro. A regra fica no
/// modelo de tela; aqui só o gesto vira o comando.
/// </summary>
public static class Comandos
{
    public static readonly AttachedProperty<ICommand?> DuploCliqueProperty =
        AvaloniaProperty.RegisterAttached<InputElement, ICommand?>("DuploClique", typeof(Comandos));

    static Comandos()
    {
        DuploCliqueProperty.Changed.AddClassHandler<InputElement>((elemento, e) =>
        {
            elemento.DoubleTapped -= AoDuploClique;
            if (e.NewValue is ICommand)
            {
                elemento.DoubleTapped += AoDuploClique;
            }
        });
    }

    public static ICommand? GetDuploClique(InputElement elemento) => elemento.GetValue(DuploCliqueProperty);

    public static void SetDuploClique(InputElement elemento, ICommand? valor) => elemento.SetValue(DuploCliqueProperty, valor);

    private static void AoDuploClique(object? sender, TappedEventArgs e)
    {
        if (sender is not InputElement elemento || GetDuploClique(elemento) is not { } comando)
        {
            return;
        }

        // A linha clicada: o DataContext do elemento sob o ponteiro (o modelo da linha, dentro do modelo de item da lista).
        var linha = (e.Source as StyledElement)?.DataContext;
        var parametro = ReferenceEquals(linha, elemento.DataContext) ? null : linha;
        if (comando.CanExecute(parametro))
        {
            comando.Execute(parametro);
            e.Handled = true;
        }
    }
}
