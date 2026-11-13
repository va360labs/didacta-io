let d = '';
process.stdin
  .on('data', (c) => (d += c))
  .on('end', () => {
    for (const l of d.split('\n')) {
      const i = l.indexOf(' {');
      if (i < 0) {
        console.log(l);
        continue;
      }
      try {
        const o = JSON.parse(l.slice(i + 1));
        if (o.bt_cobro) {
          console.log(
            l.slice(0, i),
            JSON.stringify({
              pi: o.pi,
              cobrado: o.cobrado,
              tarjeta: o.tarjeta,
              obo: o.on_behalf_of,
              descriptor: o.descriptor,
              bt: o.bt_cobro.id,
              bruto: o.bruto + ' ' + o.bt_cobro.currency,
              fee: o.fee,
              fee_det: o.bt_cobro.fee_details,
              disp: o.bt_cobro.available_on,
              comision: o.comision,
              paraCreador: o.paraCreador,
              transfer_error: o.transfer_error,
              transfer: o.transfer && {
                id: o.transfer.id,
                amount: o.transfer.amount,
                bt_plat:
                  o.transfer.bt_plataforma.id +
                  ' ' +
                  o.transfer.bt_plataforma.amount +
                  ' fee ' +
                  o.transfer.bt_plataforma.fee,
                creador:
                  o.transfer.bt_creador &&
                  o.transfer.bt_creador.id +
                    ' ' +
                    o.transfer.bt_creador.amount +
                    ' ' +
                    o.transfer.bt_creador.currency +
                    ' fee ' +
                    o.transfer.bt_creador.fee +
                    ' fx ' +
                    o.transfer.bt_creador.exchange_rate +
                    ' disp ' +
                    o.transfer.bt_creador.available_on,
              },
              neto_plataforma: o.neto_plataforma,
            }),
          );
        } else console.log(l);
      } catch {
        console.log(l);
      }
    }
  });
