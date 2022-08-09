let fs = require("fs");

let ENV = {
    OPTIMIZE_BYTECODE:true,
    SAVE_CODE:true,
    DEBUG:false
};

let debug = {
    log:function(){
        if(ENV.DEBUG)console.log(...arguments);
    }
};

//utils
let error = function(msg){
    console.error(msg);
    process.exit();
};

let toCharMap = function(str){
    return Object.fromEntries(str.split("").map(s=>[s,true]));
};

let top = function(arr){
    return arr[arr.length-1];
};

let append = function(arr1,arr2){
    for(let val of arr2){
        arr1.push(val);
    }
};

let malloc = function(size){
    let arr = [];
    for(let i = 0; i < size; i++){
        arr.push(0);
    }
    return arr;
};
//end utils




let IS = function(){
    let args = [...arguments];
    return {
        type:args[0],
        position:args[1],
        data:args.slice(2)
    }
};

let blockLookahead = function(str,i){
    let val = 0;
    //i++ to skip "]"
    i++;
    for(;i < str.length; i++){
        let c = str[i];
        if(c in toCharMap("<>.,[]")){
            break;
        }if(c === "+"){
            val++;
        }else if(c === "-"){
            val--;
        }else{
            continue;
        }
    }
    //restoring position
    i--;
    return [val,i];
};

let tryBlockOpt = function(code, /*str and strptr for lookahead*/str,strptr){
    let min = 0;
    let max = 0;
    let mptr = 0;//relative pointer location from the block origin
    for(let i = 0; i < code.length; i++){
        let ins = code[i];
        if(!(ins.type in toCharMap("+>")))return false;
        if(ins.type === ">"){
            mptr += ins.data[0];
            if(mptr < min){
                min = mptr;
            }else if(mptr > max){
                max = mptr;
            }
        }
    }
    if(mptr !== 0)return false;
    
    let memfield = malloc(max-min+1);
    for(let i = 0; i < code.length; i++){
        let ins = code[i];
        if(ins.type === ">"){
            mptr += ins.data[0];
        }else{//if type === "+"
            memfield[mptr-min] += ins.data[0];
        }
    }
    if(Math.abs(memfield[-min]) !== 1)return false;
    //all checks passed, generating optimizing code
    
    //if positive, then flip all the other signs
    if(memfield[-min] === 1){
        memfield = memfield.map(v=>-v);
    }
    
    let block = [];
    for(let mptr = min; mptr <= max; mptr++){//loops through negative to positive
        if(memfield[mptr-min] === 0 || mptr === 0)continue;
        block.push(IS("MEMMOV",strptr,mptr,memfield[mptr-min]));
    }
    
    [val,strptr] = blockLookahead(str,strptr);
    block.push(IS("MEMSET",strptr,val));
    debug.log("Pre-optimized: [() "+code.map(s=>`${s.type}(${s.data.join(",")})`).join(", ")+" ]()");
    debug.log("Optimized    : "+block.map(s=>`${s.type}(${s.data.join(",")})`).join(", "));
    return [block,strptr];
};


let getInstr = function(c,i){
    if(c === "+"){
        return IS("+",i,1);
    }else if(c === "-"){
        return IS("+",i,-1);
    }else if(c === ">"){
        return IS(">",i,1);
    }else if(c === "<"){
        return IS(">",i,-1);
    }else if(c === "."){
        return IS(".",i);
    }else if(c === ","){
        return IS(",",i);
    }else if(c === "["){
        return IS("[",i);
    }else if(c === "]"){
        return IS("]",i);
    }else{
        return false;
    }
};


let generateBytecode = function(str){
    let stackables = toCharMap("+-<>");
    
    let bytecode = [];
    let loops = [];
    let innermost = true;
    for(let i = 0; i < str.length; i++){
        let ins = getInstr(str[i],i);
        if(!ins)continue;
        if(ins.type in stackables && top(bytecode)?.type === ins.type ){
            top(bytecode).data[0] += ins.data[0];
        }else if(ins.type === "["){
            loops.push(bytecode.length);
            bytecode.push(ins);
            innermost = true;
        }else if(ins.type === "]"){
            if(loops.length === 0){
                error(`no matching "[" for "]" at character ${ins.position}`);
            }
            
            let loop_start = loops.pop();
            let loop_end = bytecode.length;
            let optResult = false;
            if(innermost === true){
                if(ENV.OPTIMIZE_BYTECODE)optResult = tryBlockOpt(bytecode.slice(loop_start+1),str,i);
                innermost = false;
            }
            if(optResult){
                let block;
                [block,i] = optResult;
                bytecode.length = loop_start;
                append(bytecode,block);
            }else{
                bytecode.push(ins);//linking will be done by jit so don't worry
            }
        }else{
            //io commands
            bytecode.push(ins);
        }
    }
    return bytecode;
};

let codegenJS = function(bytecode){
    let program = 
`let mem = new Uint8Array(100000);
let mptr = 0;
let input = [];
let iptr = 0;
let write = function(n){
process.stdout.write(String.fromCharCode(n));
};
`  +
    bytecode.map(ins=>{
        if(ins.type === "+")return `mem[mptr]+=${ins.data[0]};`;
        if(ins.type === ">")return `mptr+=${ins.data[0]};`
        if(ins.type === "[")return `while(mem[mptr]){`
        if(ins.type === "]")return `}`
        if(ins.type === ",")return `mem[mptr]=input[iptr++];`
        if(ins.type === ".")return `write(mem[mptr]);`
        if(ins.type === "MEMSET")return `mem[mptr]=${ins.data[0]};`
        if(ins.type === "MEMMOV")return `mem[mptr+${ins.data[0]}]+=mem[mptr]*${ins.data[1]};`
    }).join("\n");
    return program;
};

let evalJS = function(code){
    {eval(code);}
};


let main = function(){
    if(!process.argv[2]){
        error("Please provide input file");
    }
    let str = fs.readFileSync(process.argv[2])+"";
    //process.exit();
    
    let t0,t1;
    t0 = performance.now();
    let bytecode = generateBytecode(str);
    t1 = performance.now();
    console.log(`bytecode generation:${t1-t0}ms`);
    console.log("Bytecode size",bytecode.length);
    debug.log("Bytecode generated: "+bytecode.map(s=>`${s.type}(${s.data.join(",")})`).join(", "));
    
    if(ENV.SAVE_CODE)fs.writeFileSync(`${process.argv[2].split(".").slice(0,-1).join(".")}-${ENV.OPTIMIZE_BYTECODE?"optimized":"unoptimized"}.js`,codegenJS(bytecode),"utf-8");
    
    t0 = performance.now();
    evalJS(codegenJS(bytecode));
    t1 = performance.now();
    console.log(`execution:${t1-t0}ms`);
};


main();

















