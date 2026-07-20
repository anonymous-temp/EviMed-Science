package com.sentum.opcode;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.ToString;
import lombok.extern.slf4j.Slf4j;
import org.elasticsearch.index.query.BoolQueryBuilder;
import org.elasticsearch.index.query.QueryBuilder;

@AllArgsConstructor
@ToString
@Data
@Slf4j
public class NOT {
    public static final String NAME ="NOT";

    public static QueryBuilder execute(String ops, int type, int isPhrase, int level) {
        //log.info("{}：{}",NAME,ops);
        BoolQueryBuilder boolQueryBuilder = new BoolQueryBuilder();
        String[] array = ops.split(" NOT ");
        for (int i = 0; i < array.length; i++) {
            if (i == 0){
                String range = FormulaUtil.getRange(array[i].trim());
                String words = FormulaUtil.getWords(array[i].trim(), range);
                QueryBuilder target = FormulaUtil.createQueryBuilder(range, words, type, false, 2, isPhrase, level);
                boolQueryBuilder.must().add(target);
            }else {
                String range = FormulaUtil.getRange(array[i].trim());
                String words = FormulaUtil.getWords(array[i].trim(), range);
                QueryBuilder target = FormulaUtil.createQueryBuilder(range, words, type, false, 3, isPhrase, level);
                boolQueryBuilder.mustNot().add(target);
            }
        }
        return boolQueryBuilder;
    }
}
