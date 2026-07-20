package com.sentum.evidencecomprehensive.opcode;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.ToString;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang.StringUtils;
import org.elasticsearch.index.query.BoolQueryBuilder;
import org.elasticsearch.index.query.QueryBuilder;

import java.util.HashSet;
import java.util.Set;

@AllArgsConstructor
@ToString
@Data
@Slf4j
public class OR {
    public static final String NAME ="OR";

    public static QueryBuilder execute(String ops, int type, int isPhrase, int level) {
        //log.info("{}：{}",NAME,ops);
        BoolQueryBuilder boolQueryBuilder = new BoolQueryBuilder();
        String[] array = ops.split(" OR ");
        Set<String> ranges = new HashSet<>();
        for (String txt : array) {
            String range = FormulaUtil.getRange(txt.trim());
            if (StringUtils.isNotBlank(range)) {
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
            return FormulaUtil.createQueryBuilder(range, builder.toString(), type, true, 1, isPhrase, level);
        }else {
            for (String ops2 : array) {
                String range = FormulaUtil.getRange(ops2.trim());
                String words = FormulaUtil.getWords(ops2.trim(), range);
                QueryBuilder target = FormulaUtil.createQueryBuilder(range, words, type, false, 1, isPhrase, level);
                boolQueryBuilder.should().add(target);
            }
        }
        return boolQueryBuilder;
    }
}
