package com.sentum.opcode;

import cn.hutool.core.util.StrUtil;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.ToString;
import lombok.extern.slf4j.Slf4j;
import org.elasticsearch.index.query.BoolQueryBuilder;
import org.elasticsearch.index.query.QueryBuilder;

import java.util.HashSet;
import java.util.Set;

@Slf4j
@AllArgsConstructor
@ToString
@Data
public class AND {
    public static final String NAME ="AND";

    public static QueryBuilder execute(String ops, int type, Integer isPhrase, int level) {
        BoolQueryBuilder boolQueryBuilder = new BoolQueryBuilder();
        String[] array = ops.split(" AND ");
        Set<String> ranges = new HashSet<>();
        for (String txt : array) {
            String range = FormulaUtil.getRange(txt.trim());
            if (StrUtil.isNotBlank(range)) {
                ranges.add(range);
            }
        }
        if (ranges.size() == 1 || ranges.isEmpty()){
            String range = null;
            if (ranges.size() == 1){
                for (String s : ranges) {
                    range = s;
                }
            }
            StringBuilder builder = new StringBuilder();
            for (int i = 0; i < array.length - 1; i++) {
                builder.append(FormulaUtil.getWords(array[i], range)).append("|");
            }
            builder.append(FormulaUtil.getWords(array[array.length - 1], range));
            return FormulaUtil.createQueryBuilder(range, builder.toString(), type, true, 2, isPhrase, level);
        }else {
            for (String ops2 : array) {
                String range = FormulaUtil.getRange(ops2.trim());
                String words = FormulaUtil.getWords(ops2.trim(), range);
                QueryBuilder target = FormulaUtil.createQueryBuilder(range, words, type, false, 2, isPhrase, level);
                boolQueryBuilder.must().add(target);
            }
        }
        return boolQueryBuilder;
    }
}
